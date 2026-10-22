// Real server + real Unix protocol + installed CodingTools. SSH carries exactly this wire protocol.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MachineExecutor } from '../../src/client/machine-executor.ts';
import { RemoteSession } from '../../src/client/remote-session.ts';
import { ClientLink, unixConnector } from '../../src/client/unix-link.ts';
import { parseArgs, resolveOptions } from '../../src/host/config.ts';
import { ENABLE_TOOLS } from '../../src/protocol/messages.ts';
import type { MachineCall, MachineToolResult } from '../../src/protocol/machines.ts';
import { serve } from '../../src/server/serve.ts';
import type { MachineTarget } from '../../src/ui/types.ts';
import { call, router, say } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

async function until(ok: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await ok()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await delay(5);
  }
}

function answered(session: RemoteSession, text: string): boolean {
  return !session.status().busy && session.chat.items().some(item => item.kind === 'assistant' && item.text === text && !item.streaming);
}

test('one central chat routes two devices locally; reconnect replays the pinned ID without repeating side effects', { timeout: 45_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-machines-e2e-'));
  const serverCwd = join(folder, 'server'), aCwd = join(folder, 'device-a'), bCwd = join(folder, 'device-b');
  await Promise.all([serverCwd, aCwd, bCwd].map(path => mkdir(path)));
  const clients: RemoteSession[] = [], executors: MachineExecutor[] = [];
  const stop = new AbortController();
  let serving: Promise<void> | undefined;
  t.after(async () => {
    await Promise.all(clients.map(session => session.close()));
    stop.abort();
    await serving;
    await Promise.all(executors.map(executor => executor.close()));
    await rm(folder, { recursive: true, force: true });
  });
  const catalog = offlineModels(router({ Pi: ({ user, results, last }) => {
    if (user.endsWith('reconnect')) return last ? say('DONE-RECONNECT') : call(['bash', { command: 'printf once >> reconnect.log' }]);
    const name = user.endsWith('device A') ? 'A' : user.endsWith('device B') ? 'B' : assert.fail(`Unexpected prompt ${user}`);
    if (!results.length) return call(['write', { path: 'note.txt', content: `local-${name}` }]);
    if (results.length === 1) return call(['read', { path: 'note.txt' }]);
    return say(`DONE-${name}:${last?.text ?? ''}`);
  } }));
  const config = { ...await resolveOptions(parseArgs(['serve', '--database', join(serverCwd, 'chat.sqlite'), '--cwd', serverCwd,
    '--model', `${catalog.model.provider}/${catalog.model.modelId}`]), {}),
    roster: { Coder: { model: catalog.model, thinkingLevel: 'off' as const, tools: ['coding' as const] } } };
  assert.equal(config.allowTools, true, 'the upstream server starts with guarded tools on');
  const ready = Promise.withResolvers<void>();
  const logs: string[] = [];
  serving = serve(config, { models: catalog.models, signal: stop.signal, log: line => {
    logs.push(line);
    if (line.startsWith('ready:')) ready.resolve();
  } });
  await Promise.race([ready.promise, serving.then(() => assert.fail('Server stopped before ready'))]);
  const socket = config.socketPath ?? assert.fail('No socket');
  const targetA: MachineTarget = { machineId: 'device-a', label: 'Device A', cwd: aCwd };
  const targetB: MachineTarget = { machineId: 'device-b', label: 'Device B', cwd: bCwd };

  async function attach(target: MachineTarget, initialEnabled = false, dropResult?: (call: MachineCall) => boolean) {
    let enabled = initialEnabled;
    const calls: MachineCall[] = [], results: MachineToolResult[] = [];
    const executor = new MachineExecutor({ target, enabled, ledgerDir: join(target.cwd, 'ledger') });
    executors.push(executor);
    const link = new ClientLink({ connect: unixConnector(socket), client: `test-${target.machineId}` });
    const session = new RemoteSession(link, { target, requireMachines: true, machineToolsEnabled: () => enabled,
      setMachineTools: async value => {
        enabled = value;
        executor.setEnabled(value);
        await session.request('machine.set', value ? { enabled: true, confirm: ENABLE_TOOLS } : { enabled: false });
      } });
    clients.push(session);
    let registered: Promise<unknown> = Promise.resolve();
    const dropped = Promise.withResolvers<void>();
    link.onMessage(message => {
      if (message.t === 'ready') registered = session.request('machine.register', { registration: { target, enabled } });
      else if (message.t === 'machine.cancel') executor.cancel(message.id);
      else if (message.t === 'machine.call') {
        calls.push(message);
        void executor.execute(message).then(async result => {
          results.push(result);
          if (dropResult?.(message)) {
            // The native side effect and its ledger are complete, but the server never sees the result.
            await session.close();
            dropped.resolve();
          } else link.send({ t: 'machine.result', id: message.id, result });
        });
      }
    });
    await link.start();
    await session.ready();
    await registered;
    return { session, calls, results, dropped: dropped.promise };
  }

  const a = await attach(targetA), b = await attach(targetB);
  assert.equal(a.session.welcome()?.machines, true);
  assert.equal(a.session.welcome()?.boot, b.session.welcome()?.boot, 'both clients use the same central server');
  assert.equal(a.session.status().toolsEnabled, false);
  assert.equal(b.session.status().toolsEnabled, false);
  assert.ok(a.session.status().agents.some(agent => agent.name === 'Coder'), 'the upstream standing roster remains active');
  assert.ok((await a.session.request('machine.list', {})).machines.every(machine => !machine.enabled), 'server tools on grants no device permission');
  await a.session.setTools(true);
  await until(() => a.session.status().toolsEnabled, 'A tools permission status');
  assert.equal(b.session.status().toolsEnabled, false, 'A cannot grant B local permission');
  await a.session.send('write and read on device A', 'prompt-a');
  await until(() => answered(a.session, 'DONE-A:local-A') && answered(b.session, 'DONE-A:local-A'), 'A response on both clients');
  assert.deepEqual(a.calls.map(each => each.name), ['write', 'read']);
  assert.equal(b.calls.length, 0);
  assert.equal(await readFile(join(aCwd, 'note.txt'), 'utf8'), 'local-A');
  await assert.rejects(stat(join(bCwd, 'note.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(join(serverCwd, 'note.txt')), { code: 'ENOENT' });

  // The server is enabled, but B is still disabled: its submitted tool must wait, not run on A or the server.
  await b.session.send('write and read on device B', 'prompt-b');
  await until(() => logs.some(line => line.includes('Waiting for the authorized connector of Device B')), 'disabled B waits');
  assert.equal(b.calls.length, 0);
  assert.equal(a.calls.length, 2);
  await assert.rejects(stat(join(bCwd, 'note.txt')), { code: 'ENOENT' });
  await b.session.setTools(true);
  await until(() => answered(a.session, 'DONE-B:local-B') && answered(b.session, 'DONE-B:local-B'), 'B response on both clients');
  assert.deepEqual(b.calls.map(each => each.name), ['write', 'read']);
  assert.equal(await readFile(join(bCwd, 'note.txt'), 'utf8'), 'local-B');
  assert.equal(await readFile(join(aCwd, 'note.txt'), 'utf8'), 'local-A');
  await assert.rejects(stat(join(serverCwd, 'note.txt')), { code: 'ENOENT' });
  await until(() => JSON.stringify(a.session.chat.items()) === JSON.stringify(b.session.chat.items()), 'identical shared history');
  assert.equal(a.session.chat.items().filter(item => item.kind === 'user').length, 2);

  // Reopen A's connector, intentionally lose a completed result, then recover from its on-disk native ledger.
  await a.session.close();
  await until(async () => !(await b.session.request('machine.list', {})).machines.some(machine => machine.target.machineId === targetA.machineId), 'A disconnect');
  const interrupted = await attach(targetA, true, message => message.name === 'bash');
  await interrupted.session.send('reconnect', 'prompt-reconnect');
  await interrupted.dropped;
  assert.equal(await readFile(join(aCwd, 'reconnect.log'), 'utf8'), 'once');
  await until(async () => !(await b.session.request('machine.list', {})).machines.some(machine => machine.target.machineId === targetA.machineId), 'lost result connector disconnect');
  assert.equal(b.calls.length, 2, 'pending A work never runs on B');
  await until(() => b.session.status().busy, 'pending A turn stays busy');
  await assert.rejects(stat(join(serverCwd, 'reconnect.log')), { code: 'ENOENT' });
  await assert.rejects(stat(join(bCwd, 'reconnect.log')), { code: 'ENOENT' });
  const restored = await attach(targetA, true);
  await until(() => answered(restored.session, 'DONE-RECONNECT') && answered(b.session, 'DONE-RECONNECT'), 'replayed result completes the shared turn');
  assert.equal(restored.calls.length, 1);
  assert.deepEqual(restored.calls[0], interrupted.calls[0], 'the durable execution ID, payload and target survive reconnect');
  assert.equal(await readFile(join(aCwd, 'reconnect.log'), 'utf8'), 'once', 'native bash side effect is not repeated');
  assert.ok([...a.calls, ...interrupted.calls, ...restored.calls].every(each => each.target.machineId === targetA.machineId && each.target.cwd === aCwd));
  assert.ok(b.calls.every(each => each.target.machineId === targetB.machineId && each.target.cwd === bCwd));
  assert.ok([...a.results, ...b.results, ...interrupted.results, ...restored.results].every(result => !result.isError));
  await until(() => JSON.stringify(restored.session.chat.items()) === JSON.stringify(b.session.chat.items()), 'history after reconnect');
  assert.equal(restored.session.chat.items().filter(item => item.kind === 'user').length, 3);
});
