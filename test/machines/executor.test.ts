import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MachineExecutor } from '../../src/client/machine-executor.ts';
import type { MachineExecutorOptions } from '../../src/client/machine-executor.ts';
import type { MachineCall, MachineToolResult } from '../../src/protocol/machines.ts';
import { LIMITS } from '../../src/protocol/messages.ts';
import { bwrapBinary } from '../../src/runtime/guard.ts';

const hasBwrap = (() => {
  try { execFileSync(bwrapBinary(), ['--dev-bind', '/', '/', '--', '/bin/sh', '-c', 'true'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

async function fixture(t: TestContext, options: Partial<MachineExecutorOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'machine-executor-'));
  const target = { machineId: 'laptop', cwd, label: 'Laptop' };
  const ledgerDir = join(cwd, 'ledger');
  const executor = new MachineExecutor({ target, ledgerDir, enabled: true, ...options });
  t.after(async () => { await executor.close(); await rm(cwd, { recursive: true, force: true }); });
  function call(id: string, name: MachineCall['name'], args: MachineCall['args']): MachineCall {
    return { t: 'machine.call', id, target, name, args };
  }
  return { cwd, target, ledgerDir, executor, call };
}
function text(result: MachineToolResult): string {
  return result.output?.map(block => block.type === 'text' ? block.text : '').join('') ?? '';
}
function code(result: MachineToolResult): string | undefined { return result.diagnostics?.find(item => item.severity === 'error')?.code; }
function directory(ledgerDir: string, id: string): string {
  return join(ledgerDir, createHash('sha256').update(id).digest('hex'));
}

test('installed CodingTools perform real guarded write/read/edit with native results', async t => {
  const { cwd, executor, call } = await fixture(t);
  assert.match(text(await executor.execute(call('write', 'write', { path: 'nested/file.txt', content: 'one\ntwo\nthree' }))), /Successfully wrote/u);
  const read = await executor.execute(call('read', 'read', { path: 'nested/file.txt', offset: 2, limit: 1 }));
  assert.equal(text(read), 'two');
  assert.match(read.diagnostics?.[0]?.message ?? '', /more lines/u);
  const edit = await executor.execute(call('edit', 'edit', { path: 'nested/file.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }));
  assert.equal(edit.isError, undefined);
  assert.match(JSON.stringify(edit.details), /TWO/u);
  assert.equal(await readFile(join(cwd, 'nested/file.txt'), 'utf8'), 'one\nTWO\nthree');
});

test('native bash runs through bubblewrap and keeps native results', { skip: !hasBwrap && 'working bubblewrap required' }, async t => {
  const { executor, call } = await fixture(t);
  const bash = await executor.execute(call('bash', 'bash', { command: 'printf "shell-ready"' }));
  assert.equal(text(bash), 'shell-ready');
  assert.deepEqual(bash.structuredOutput, { output: 'shell-ready', truncated: false, exitCode: 0 });
  const nonzero = await executor.execute(call('nonzero', 'bash', { command: 'printf failed; exit 7' }));
  assert.equal(nonzero.isError, true);
  assert.equal(code(nonzero), 'exit_code');
  assert.equal(text(nonzero), 'failed');
});

test('native image reads retain image blocks and conservatively report unknown vision support', async t => {
  const { cwd, executor, call } = await fixture(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ZcAAAAASUVORK5CYII=';
  await writeFile(join(cwd, 'pixel.png'), Buffer.from(png, 'base64'));
  const result = await executor.execute(call('image', 'read', { path: 'pixel.png' }));
  assert.deepEqual(result.output, [{ type: 'image', data: png, mimeType: 'image/png' }]);
  assert.match(result.diagnostics?.[0]?.message ?? '', /does not support images/u);
});

test('native argument repair, validation, and exact edit failure are retained', async t => {
  const { cwd, executor, call } = await fixture(t);
  await writeFile(join(cwd, 'file'), 'unique');
  const legacy = await executor.execute(call('legacy', 'edit', { path: 'file', oldText: 'unique', newText: 'new' }));
  assert.equal(legacy.isError, undefined);
  const mismatch = await executor.execute(call('bad-edit', 'edit', { path: 'file', edits: [{ oldText: 'absent', newText: 'oops' }] }));
  assert.equal(mismatch.isError, true);
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), 'new');
  const invalid = await executor.execute(call('invalid', 'write', { path: 'file' }));
  assert.equal(invalid.isError, true);
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), 'new');
});

test('cwd scopes routing, not the project boundary: unprotected absolute paths outside it still work', async t => {
  const { executor, call } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'machine-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, 'file');
  assert.equal((await executor.execute(call('outside', 'write', { path, content: 'outside' }))).isError, undefined);
  assert.equal(await readFile(path, 'utf8'), 'outside');
});

test('native tools hide local state, auth, client config, the ledger and extra paths, including symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'machine-protection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'state'), agentDir = join(root, 'agent'), configDir = join(root, 'config'), extra = join(root, 'extra');
  const auth = join(agentDir, 'auth.json'), config = join(configDir, 'client.json');
  const memory = join(dataDir, 'chat.unii', 'browser', '7', 'Cookies');
  for (const path of [join(dataDir, 'chat.unii', 'browser', '7'), agentDir, configDir, extra]) await mkdir(path, { recursive: true });
  const files = [join(dataDir, 'chat.sqlite'), memory, auth, config, join(extra, 'private')];
  for (const path of files) await writeFile(path, 'PRIVATE CONTENT');
  const { cwd, executor, ledgerDir, call } = await fixture(t, { env: { ...process.env,
    PI_DURABLE_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir, PI_DURABLE_CLIENT_CONFIG: config }, protectedPaths: [extra] });
  await executor.execute(call('ordinary', 'write', { path: 'okay', content: 'normal' }));
  const intent = join(directory(ledgerDir, 'ordinary'), 'intent.json');
  files.push(intent);
  await symlink(dataDir, join(cwd, 'state-alias'));
  files.push(join(cwd, 'state-alias', 'chat.sqlite'));
  for (const [index, path] of files.entries()) {
    const original = await readFile(path, 'utf8');
    const read = await executor.execute(call(`hidden-read-${index}`, 'read', { path }));
    assert.equal(read.isError, true, path);
    assert.match(JSON.stringify(read), /protected/u, path);
    assert.doesNotMatch(JSON.stringify(read), /PRIVATE CONTENT/u, path);
    const write = await executor.execute(call(`hidden-write-${index}`, 'write', { path, content: 'changed' }));
    assert.equal(write.isError, true, path);
    assert.match(JSON.stringify(write), /protected/u, path);
    const edit = await executor.execute(call(`hidden-edit-${index}`, 'edit', { path, edits: [{ oldText: original, newText: 'changed' }] }));
    assert.equal(edit.isError, true, path);
    assert.equal(await readFile(path, 'utf8'), original, path);
  }
  const system = await executor.execute(call('system-write', 'write', { path: `/etc/pi-durable-executor-${process.pid}`, content: 'forbidden' }));
  assert.equal(system.isError, true);
  assert.match(JSON.stringify(system), /read-only for Pi/u);
});

test('default guard derives local protection without creating or reading local chat configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'machine-no-local-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'state'), configDir = join(root, 'config');
  const { executor, call } = await fixture(t, { env: { ...process.env, PI_DURABLE_DATA_DIR: dataDir,
    PI_DURABLE_CLIENT_CONFIG: join(configDir, 'client.json'), PI_CODING_AGENT_DIR: join(root, 'agent') } });
  assert.equal((await executor.execute(call('write', 'write', { path: 'ordinary', content: 'fine' }))).isError, undefined);
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
  await assert.rejects(stat(configDir), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'agent')), { code: 'ENOENT' });
});

test('native bash sees only the connector\'s own SSH agent, never the launch environment\'s', { skip: !hasBwrap && 'working bubblewrap required' }, async t => {
  const { executor, call } = await fixture(t, { sshAgent: '/run/pi-ssh-test/agent', env: { ...process.env, SSH_AUTH_SOCK: '/tmp/user-agent' } });
  assert.equal(text(await executor.execute(call('agent', 'bash', { command: 'printf "$SSH_AUTH_SOCK"' }))), '/run/pi-ssh-test/agent');
  const none = await fixture(t, { env: { ...process.env, SSH_AUTH_SOCK: '/tmp/user-agent' } });
  assert.equal(text(await none.executor.execute(none.call('none', 'bash', { command: 'printf "[$SSH_AUTH_SOCK]"' }))), '[]');
});

test('without working bubblewrap native bash fails closed, caches refusal and never runs bare', async t => {
  const { cwd, executor, call } = await fixture(t, { env: { ...process.env, PI_DURABLE_BWRAP: '/nonexistent/pi-durable-test-bwrap' } });
  const request = call('no-bwrap', 'bash', { command: 'printf UNSAFE > escaped' });
  const result = await executor.execute(request);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /bash is off: .*not installed/u);
  await assert.rejects(stat(join(cwd, 'escaped')), { code: 'ENOENT' });
  assert.deepEqual(await executor.execute(request), result);
});

test('native bash cannot see or alter hidden state through its bubblewrap mount', { skip: !hasBwrap && 'working bubblewrap required' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'machine-bash-protection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hidden = join(root, 'hidden');
  await mkdir(hidden);
  const secret = join(hidden, 'secret');
  await writeFile(secret, 'PRIVATE BASH CONTENT');
  const { executor, call } = await fixture(t, { protectedPaths: [hidden] });
  const result = await executor.execute(call('bash-hidden', 'bash', {
    command: `cat ${JSON.stringify(secret)} 2>&1; printf changed > ${JSON.stringify(secret)}; printf safe`,
  }));
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BASH CONTENT/u);
  assert.match(text(result), /safe/u);
  assert.equal(await readFile(secret, 'utf8'), 'PRIVATE BASH CONTENT');
});

test('permission is off by default and not restored from the ledger', async t => {
  const { cwd, target, ledgerDir, executor, call } = await fixture(t);
  const request = call('write', 'write', { path: 'file', content: 'once' });
  await executor.execute(request);
  const reopened = new MachineExecutor({ target, ledgerDir });
  t.after(() => reopened.close());
  const off = await reopened.execute(request);
  assert.equal(code(off), 'TOOLS_DISABLED');
  // Pi learns which machine refused and what the user there can do about it.
  assert.equal(text(off), 'Machine tools are off on Laptop. Only the user there can turn them on, with /tools on in that terminal.');
  reopened.setEnabled(true);
  assert.equal((await reopened.execute(request)).isError, undefined);
  reopened.setEnabled(false);
  assert.equal(code(await reopened.execute(call('off', 'write', { path: 'other', content: 'no' }))), 'TOOLS_DISABLED');
  assert.equal(await readFile(join(cwd, 'file'), 'utf8'), 'once');
  assert.equal((await readdir(cwd)).includes('other'), false);
});

test('target identity and launch root must match exactly; label is informational', async t => {
  let executions = 0;
  const { executor, call, cwd } = await fixture(t, { execute: () => { executions++; return Promise.resolve({}); } });
  const request = call('id', 'bash', { command: 'unused' });
  for (const target of [{ ...request.target, machineId: 'other' }, { ...request.target, cwd: `${cwd}/` }, { ...request.target, cwd: '/' }]) {
    assert.equal(code(await executor.execute({ ...request, target })), 'TARGET_NOT_APPROVED');
  }
  assert.equal(executions, 0);
  assert.equal((await executor.execute({ ...request, target: { ...request.target, label: 'Renamed' } })).isError, undefined);
  assert.equal(executions, 1);
  // Simulate an untrusted caller bypassing the TypeScript union.
  const invalid: unknown = { ...request, name: 'spawn_agent' };
  assert.equal(code(await executor.execute(invalid as MachineCall)), 'INVALID_CALL');
});

test('durable intent precedes execution; live duplicates share one promise and payload changes fail', { timeout: 10_000 }, async t => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<MachineToolResult>();
  let count = 0;
  const setup = await fixture(t, { execute: async request => {
    count++;
    const saved: unknown = JSON.parse(await readFile(join(directory(setup.ledgerDir, request.id), 'intent.json'), 'utf8'));
    assert.ok(typeof saved === 'object' && saved !== null && 'fingerprint' in saved && 'call' in saved);
    started.resolve();
    return finish.promise;
  } });
  const request = setup.call('../odd/id', 'bash', { command: 'once', timeout: 1 });
  const first = setup.executor.execute(request);
  const same = setup.executor.execute({ ...request, args: { timeout: 1, command: 'once' }, target: { ...request.target, label: 'New label' } });
  assert.equal(first, same);
  await started.promise;
  const changed = await setup.executor.execute({ ...request, args: { command: 'different' } });
  assert.equal(code(changed), 'PAYLOAD_MISMATCH');
  finish.resolve({ output: [{ type: 'text', text: 'done' }], details: { count: 1 } });
  assert.equal(text(await first), 'done');
  assert.equal(count, 1);
  assert.equal((await readdir(setup.ledgerDir))[0], createHash('sha256').update(request.id).digest('hex'));
  const reopened = new MachineExecutor({ target: setup.target, ledgerDir: setup.ledgerDir, enabled: true,
    execute: () => { throw new Error('Must not replay'); } });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.execute(request), await first);
  assert.equal(code(await reopened.execute({ ...request, name: 'read' })), 'PAYLOAD_MISMATCH');
});

test('explicit cancel aborts live work and caches the cancellation', { timeout: 10_000 }, async t => {
  const started = Promise.withResolvers<void>();
  let observed = false;
  const { executor, call } = await fixture(t, { execute: (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { observed = true; reject(signal.reason); }, { once: true });
    started.resolve();
  }) });
  const request = call('cancel', 'bash', { command: 'wait' });
  const result = executor.execute(request);
  await started.promise;
  executor.cancel('cancel');
  assert.equal(code(await result), 'CANCELLED');
  assert.equal(observed, true);
  assert.deepEqual(await executor.execute(request), await result);
  executor.cancel('unknown');
});

test('cancelling before durable admission prevents side effects and caches cancellation', async t => {
  let count = 0;
  const { executor, call } = await fixture(t, { execute: () => { count++; return Promise.resolve({}); } });
  const request = call('early-cancel', 'write', { path: 'no', content: 'no' });
  const pending = executor.execute(request);
  executor.cancel(request.id);
  assert.equal(code(await pending), 'CANCELLED');
  assert.deepEqual(await executor.execute(request), await pending);
  assert.equal(count, 0);
});

test('native bash observes chord context cancellation and timeout', { timeout: 10_000, skip: !hasBwrap && 'working bubblewrap required' }, async t => {
  const { executor, call } = await fixture(t);
  const result = executor.execute(call('cancel-native', 'bash', { command: 'sleep 30' }));
  const timer = setTimeout(() => executor.cancel('cancel-native'), 150);
  try { assert.equal(code(await result), 'CANCELLED'); } finally { clearTimeout(timer); }
  const timed = await executor.execute(call('timeout', 'bash', { command: 'sleep 30', timeout: 0.05 }));
  assert.equal(timed.isError, true);
  assert.match(timed.diagnostics?.[0]?.message ?? '', /timed out/u);
});

test('close drains admitted work without cancelling it and caches its result', { timeout: 10_000 }, async t => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<MachineToolResult>();
  let signal: AbortSignal | undefined;
  const { executor, call } = await fixture(t, { execute: (_call, value) => { signal = value; started.resolve(); return finish.promise; } });
  const request = call('drain', 'bash', { command: 'wait' });
  const pending = executor.execute(request);
  await started.promise;
  const closing = executor.close();
  assert.equal(signal?.aborted, false);
  assert.equal(code(await executor.execute(call('new', 'read', { path: 'file' }))), 'CLOSED');
  finish.resolve({ output: [{ type: 'text', text: 'finished' }] });
  assert.equal(text(await pending), 'finished');
  await closing;
});

test('crashed or concurrently owned intents never replay across processes', { timeout: 10_000 }, async t => {
  const { target, ledgerDir, executor, call, cwd } = await fixture(t);
  const moduleUrl = new URL('../../src/client/machine-executor.ts', import.meta.url).href;
  const request = call('crashed', 'bash', { command: 'once' });
  const script = `
    import { MachineExecutor } from ${JSON.stringify(moduleUrl)};
    import { appendFile } from 'node:fs/promises';
    const executor = new MachineExecutor({target: ${JSON.stringify(target)}, ledgerDir: ${JSON.stringify(ledgerDir)}, enabled: true,
      execute: async () => {
        await appendFile(${JSON.stringify(join(cwd, 'effects'))}, 'once\\n');
        process.stdout.write('started');
        return new Promise(() => { setInterval(() => {}, 1000); });
      }});
    await executor.execute(${JSON.stringify(request)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await once(child.stdout, 'data');
  assert.equal(code(await executor.execute(request)), 'INDETERMINATE');
  child.kill('SIGKILL');
  await exit;
  const reopened = new MachineExecutor({ target, ledgerDir, enabled: true, execute: () => { throw new Error('Must never rerun'); } });
  t.after(() => reopened.close());
  assert.equal(code(await reopened.execute(request)), 'INDETERMINATE');
  assert.equal(await readFile(join(cwd, 'effects'), 'utf8'), 'once\n');
});

test('even an empty claimed directory and a broken ledger fail closed', async t => {
  let count = 0;
  const { executor, call, ledgerDir } = await fixture(t, { execute: () => { count++; return Promise.resolve({}); } });
  await mkdir(directory(ledgerDir, 'orphan'), { recursive: true });
  assert.equal(code(await executor.execute(call('orphan', 'write', { path: 'no', content: 'no' }))), 'INDETERMINATE');
  await writeFile(join(directory(ledgerDir, 'orphan'), 'intent.json'), '{broken');
  assert.equal(code(await executor.execute(call('orphan', 'write', { path: 'no', content: 'no' }))), 'INDETERMINATE');
  assert.equal(count, 0);
});

test('oversized external results are discarded, cached, and never re-executed', async t => {
  let count = 0;
  const { executor, call } = await fixture(t, { execute: () => {
    count++;
    return Promise.resolve({ output: [{ type: 'text', text: '😀'.repeat(LIMITS.clientMessage / 2) }], details: { effect: 'already happened' } });
  } });
  const request = call('huge', 'bash', { command: 'huge' });
  const result = await executor.execute(request);
  assert.equal(code(result), 'RESULT_TOO_LARGE');
  assert.equal(result.details, undefined);
  assert.ok(JSON.stringify({ t: 'machine.result', id: request.id, result }).length < LIMITS.clientMessage);
  assert.deepEqual(await executor.execute(request), result);
  assert.equal(count, 1);
});
