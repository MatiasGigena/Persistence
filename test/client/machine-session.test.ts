import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteSession } from '../../src/client/remote-session.ts';
import { ClientLink } from '../../src/client/unix-link.ts';
import type { Connector } from '../../src/client/unix-link.ts';
import { isParseError, parseClientMessage, parseServerMessage } from '../../src/protocol/parse.ts';
import type { MachineCall, MachineTarget } from '../../src/protocol/machines.ts';
import { FakeServer } from '../fixtures/fake-server.ts';
import { memoryConnector } from './memory-link.ts';
import { connectMachine } from '../../src/client/machine-link.ts';

const target: MachineTarget = { machineId: 'laptop', label: 'Laptop', cwd: '/local/project' };

async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await delay(2);
  }
}

function machineConnector(connect: Connector): Connector {
  return events => connect({ ...events, message: text => {
    const message = parseServerMessage(text);
    events.message(!isParseError(message) && message.t === 'welcome' ? JSON.stringify({ ...message, machines: true }) : text);
  } });
}

function sends(texts: readonly string[]) {
  return texts.flatMap(text => {
    const message = parseClientMessage(text);
    return !isParseError(message) && message.t === 'req' && message.op === 'send' ? [message.params] : [];
  });
}

test('a machine session rejects an older server before sending user work', async t => {
  const wire = memoryConnector(new FakeServer());
  const link = new ClientLink({ connect: wire.connect, client: 'machine-test' });
  const session = new RemoteSession(link, { target, requireMachines: true });
  t.after(() => session.close());
  await Promise.allSettled([link.start()]);
  await assert.rejects(session.ready(), /lacks machine routing/);
  assert.equal(link.state(), 'closed');
  await assert.rejects(session.send('must not go to the server'), /Not connected/);
  assert.deepEqual(sends(wire.sent), []);
});

test('a reconnect resends the same request ID and original local target, never the server directory', async t => {
  const server = new FakeServer({ cwd: '/central/server' });
  server.hold('send');
  const wire = memoryConnector(server);
  const link = new ClientLink({ connect: machineConnector(wire.connect), client: 'machine-test', retry: { first: 5, max: 10 } });
  const session = new RemoteSession(link, { target, requireMachines: true, clientId: 'laptop-test' });
  t.after(() => session.close());
  await link.start();
  await session.ready();
  const pending = session.send('write locally');
  await until(() => server.requests.some(request => request.op === 'send'), 'the first send');
  const first = sends(wire.sent)[0] ?? assert.fail('no send');
  assert.deepEqual(first.target, target);
  wire.peers.at(-1)?.drop();
  await until(() => sends(wire.sent).length === 2, 'the replay');
  assert.deepEqual(sends(wire.sent), [first, first]);
  assert.equal(server.sends.length, 1, 'the server deduplicates the replay');
  server.release('send');
  await pending;
  assert.equal(session.welcome()?.cwd, '/central/server');
  assert.deepEqual(session.status().machine, target);
});

test('server-wide tools permission never implies local permission, and failed enabling rolls back locally', async t => {
  const server = new FakeServer();
  const agents = [{ name: 'Coder', role: 'main' as const, parent: 'Pi', busy: false }];
  server.setStatus({ toolsEnabled: true, thinkingLevel: 'low', agents });
  const wire = memoryConnector(server);
  const link = new ClientLink({ connect: machineConnector(wire.connect), client: 'machine-test' });
  let enabled = false;
  const toggles: boolean[] = [];
  const session = new RemoteSession(link, { target, requireMachines: true, requestTimeoutMs: 25,
    machineToolsEnabled: () => enabled,
    setMachineTools: value => { toggles.push(value); enabled = value; return Promise.resolve(); } });
  t.after(() => session.close());
  await link.start();
  await session.ready();
  assert.equal(session.status().toolsEnabled, false, 'the server default or another client does not grant this device permission');
  assert.equal(session.status().thinkingLevel, 'low', 'the central server retains its chosen effort');
  assert.deepEqual(session.status().agents, agents, 'standing agents remain visible on the remote client');
  server.hold('tools.set');
  await assert.rejects(session.setTools(true), { code: 'timeout' });
  assert.deepEqual(toggles, [true, false]);
  assert.equal(enabled, false);
  assert.equal(session.status().toolsEnabled, false);
});

test('connectMachine registers with this process\'s grant, runs the server\'s calls locally, and follows /tools', async t => {
  const server = new FakeServer();
  const wire = memoryConnector(server);
  const link = new ClientLink({ connect: machineConnector(wire.connect), client: 'machine-test' });
  const ran: string[] = [], grants: boolean[] = [];
  const runner = {
    execute: (call: MachineCall) => { ran.push(call.id); return Promise.resolve({ output: [{ type: 'text' as const, text: 'done' }] }); },
    cancel: () => undefined,
    setEnabled: (enabled: boolean) => { grants.push(enabled); },
  };
  const { session, registered, dispose } = connectMachine(link, target, runner, { enabled: false });
  t.after(() => { dispose(); return session.close(); });
  await link.start();
  await session.ready();
  await registered();
  assert.deepEqual(server.machines, [{ op: 'machine.register', enabled: false }], 'no --allow-tools: registered without the grant');
  wire.peers.at(-1)?.push({ t: 'machine.call', id: 'chat:task-1', target, name: 'read', args: { path: 'a.txt' } });
  await until(() => wire.sent.some(text => text.includes('"machine.result"')), 'the result');
  assert.deepEqual(ran, ['chat:task-1']);
  assert.match(wire.sent.find(text => text.includes('"machine.result"')) ?? '', /"id":"chat:task-1".*"done"/);
  await session.setTools(true);
  assert.deepEqual(grants, [true]);
  assert.deepEqual(server.machines.at(-1), { op: 'machine.set', enabled: true });
});
