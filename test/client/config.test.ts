import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { clientConfigPath, machineId, readClientConfig, remoteTarget, saveClientConfig } from '../../src/client/config.ts';
import { parseArgs } from '../../src/config/options.ts';
import { resolveSocketPath } from '../../src/config/paths.ts';

const exec = promisify(execFile), launcher = resolve('bin/pi-durable');
const id = 'ab0c2d3e-0000-4000-8000-123456789abc';

async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<{ folder: string; env: NodeJS.ProcessEnv }> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-client-config-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return { folder, env: { ...process.env, PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json'),
    PI_DURABLE_DATA_DIR: join(folder, 'local-state'), PI_DURABLE_REMOTE: '', XDG_RUNTIME_DIR: '' } };
}

test('remote subcommands and flags parse strictly without changing local defaults', () => {
  const options = parseArgs(['connect', 'user@central', '--remote-bin', '/opt/pi durable/bin/pi-durable', '--remote-data-dir', '/srv/chat']);
  assert.equal(options.command, 'connect');
  assert.equal(options.remote, 'user@central');
  assert.equal(options.remoteBin, '/opt/pi durable/bin/pi-durable');
  assert.equal(options.remoteDataDir, '/srv/chat');
  assert.equal(parseArgs(['bridge', '--database', '/state/chat.sqlite']).command, 'bridge');
  assert.equal(parseArgs(['--remote', 'central', '--allow-tools', '--cwd', '/work']).allowTools, true);
  assert.equal(parseArgs([]).remote, undefined);
  assert.equal(parseArgs([]).allowTools, true, 'upstream local launches keep tools on');
  assert.equal(parseArgs([]).remoteAllowTools, false, 'local defaults never grant remote machine permission');
  assert.equal(parseArgs(['--remote', 'central']).remoteAllowTools, false);
  assert.equal(parseArgs(['--remote', 'central', '--allow-tools']).remoteAllowTools, true);
  assert.equal(parseArgs(['--remote', 'central', '--no-tools']).remoteAllowTools, false);
  assert.equal(parseArgs(['--remote', 'central', '--no-tools']).allowTools, false);
  assert.equal(parseArgs(['serve']).allowTools, true, 'upstream server tools policy is unchanged');
  assert.equal(parseArgs(['serve']).remoteAllowTools, false);
  for (const args of [['connect'], ['connect', 'a', 'b'], ['connect', 'a', '--allow-tools'], ['connect', 'a', '--database', 'x'],
    ['bridge', '--allow-tools'], ['bridge', 'prompt'], ['serve', '--remote', 'a'], ['--remote', 'a', '--local'],
    ['--local', '--remote-bin', '/bin/pi'], ['--remote'], ['connect', 'a', '--', 'b'],
    ['connect', 'a', '--remote-bin', '/one', '--remote-bin', '/two'],
    ['--remote', 'central', '--allow-tools', '--no-tools']]) {
    assert.throws(() => parseArgs(args), Error, JSON.stringify(args));
  }
});

test('client paths honor overrides; missing configuration is read-only', async t => {
  const { folder, env } = await fixture(t);
  delete env.PI_DURABLE_REMOTE;
  assert.equal(clientConfigPath({ XDG_CONFIG_HOME: folder }), join(folder, 'pi-durable', 'client.json'));
  assert.equal(clientConfigPath(env), join(folder, 'client.json'));
  assert.equal(await readClientConfig(env), undefined);
  assert.equal(await remoteTarget(parseArgs([]), env), undefined);
  assert.deepEqual(await readdir(folder), []);
});

test('configuration is atomic/private and stores no launch tools permission', async t => {
  const { folder, env } = await fixture(t);
  await saveClientConfig({ machineId: id, ssh: { host: 'central', command: '/opt/bin/pi-durable', dataDir: '/srv/chat' } }, env);
  assert.equal((await stat(clientConfigPath(env))).mode & 0o777, 0o600);
  assert.deepEqual(await readClientConfig(env), { machineId: id, ssh: { host: 'central', command: '/opt/bin/pi-durable', dataDir: '/srv/chat' } });
  assert.doesNotMatch(await readFile(clientConfigPath(env), 'utf8'), /allowTools|permission/);
  assert.deepEqual(await readdir(folder), ['client.json']);
  await assert.rejects(stat(join(folder, 'local-state')), { code: 'ENOENT' });
});

test('malformed, unknown, or unsafe saved settings reject; --local explicitly bypasses them', async t => {
  const { env } = await fixture(t);
  // Each refusal says what is wrong, so a hand edit can be fixed without guessing.
  const parseError = ((): string => { try { JSON.parse('{'); return ''; } catch (error) { return error instanceof Error ? error.message : ''; } })();
  for (const [value, why] of [['{', `it is not valid JSON (${parseError})`], ['[]', 'it must be an object like {"machineId":…,"ssh":{"host":…}}'],
    ['{}', 'machineId must be a UUID'], [JSON.stringify({ machineId: 'not-an-id' }), 'machineId must be a UUID'],
    [JSON.stringify({ machineId: id, allowTools: true }), 'unknown key allowTools'],
    [JSON.stringify({ machineId: id, ssh: { host: '-oProxyCommand=bad' } }), 'Invalid SSH host: use [user@]host (configure ports in ~/.ssh/config)'],
    [JSON.stringify({ machineId: id, ssh: { host: 'central', command: 4 } }), 'ssh.command must be a string'],
    [JSON.stringify({ machineId: id, ssh: { host: 'central', password: 'not-allowed' } }), 'unknown key ssh.password (ports, users and keys go in ~/.ssh/config)']] as const) {
    await writeFile(clientConfigPath(env), value);
    await assert.rejects(readClientConfig(env), { message: `Invalid remote client configuration at ${clientConfigPath(env)}: ${why}; fix it or use --local` });
    assert.equal(await remoteTarget(parseArgs(['--local']), env), undefined);
  }
});

test('explicit host and environment override saved host without copying the wrong remote paths', async t => {
  const { env } = await fixture(t);
  delete env.PI_DURABLE_REMOTE;
  await saveClientConfig({ machineId: id, ssh: { host: 'saved', command: '/saved/bin', dataDir: '/saved/state' } }, env);
  assert.deepEqual((await remoteTarget(parseArgs([]), env))?.target, { host: 'saved', command: '/saved/bin', dataDir: '/saved/state' });
  assert.deepEqual((await remoteTarget(parseArgs(['--remote', 'once', '--remote-bin', '/once/bin']), env))?.target, { host: 'once', command: '/once/bin' });
  assert.deepEqual((await remoteTarget(parseArgs([]), { ...env, PI_DURABLE_REMOTE: 'environment' }))?.target, { host: 'environment' });
  assert.equal((await readClientConfig(env))?.ssh?.host, 'saved');
  assert.equal(await remoteTarget(parseArgs(['--local']), { ...env, PI_DURABLE_REMOTE: 'environment' }), undefined);
});

test('unsupported remote modes fail with --local advice before touching local state', async t => {
  const { folder, env } = await fixture(t);
  delete env.PI_DURABLE_REMOTE;
  await saveClientConfig({ machineId: id, ssh: { host: 'saved' } }, env);
  for (const args of [['-p', 'hello'], ['hello'], ['--plain'], ['--status'], ['--history'], ['--resume'], ['--model', 'provider/model'],
    ['--thinking', 'high'], ['--auth-file', '/absent'], ['--database', '/absent'], ['--data-dir', '/absent']]) {
    await assert.rejects(remoteTarget(parseArgs(args), env), /not supported for remote chat; use --local/, JSON.stringify(args));
  }
  assert.equal((await remoteTarget(parseArgs(['--cwd', folder, '--allow-tools']), env))?.target.host, 'saved');
  assert.equal((await remoteTarget(parseArgs(['--no-tools']), env))?.target.host, 'saved');
  assert.equal(parseArgs(['--thinking', 'low']).remoteUnsupported, '--thinking', 'effort remains a server-side choice');
  await assert.rejects(exec(launcher, ['--status'], { env: { ...env, PI_DURABLE_MODEL: 'invalid' } }), { stderr: /not supported for remote chat; use --local/ });
  await assert.rejects(exec(launcher, [], { env: { ...env, PI_DURABLE_MODEL: 'invalid' } }), { stderr: /Remote chat needs a terminal/ });
  await assert.rejects(stat(join(folder, 'local-state')), { code: 'ENOENT' });
});

test('one-launch identity is stable including concurrent creation, without saving a remote default', async t => {
  const { folder, env } = await fixture(t);
  const ids = await Promise.all(Array.from({ length: 8 }, () => machineId(env)));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await machineId(env), ids[0]);
  assert.equal((await stat(join(folder, 'machine-id'))).mode & 0o777, 0o600);
  assert.equal(await readClientConfig(env), undefined);
  assert.equal(await machineId(env, { machineId: id }), id);
  assert.deepEqual(await readdir(folder), ['machine-id']);
});

test('connect saves settings only, preserves identity and local bytes, and reports configured not connected', async t => {
  const { folder, env } = await fixture(t);
  const local = join(folder, 'chat.sqlite');
  await writeFile(local, 'untouched local state');
  const existing = await machineId(env);
  const { stdout } = await exec(launcher, ['connect', 'central', '--remote-bin', '/opt/pi/bin/pi-durable', '--remote-data-dir', '/remote/state'], { env });
  assert.match(stdout, /Configured remote server central/);
  assert.doesNotMatch(stdout, /Connected/);
  assert.deepEqual(await readClientConfig(env), { machineId: existing, ssh: { host: 'central', command: '/opt/pi/bin/pi-durable', dataDir: '/remote/state' } });
  await exec(launcher, ['connect', 'other'], { env });
  assert.equal((await readClientConfig(env))?.machineId, existing);
  assert.equal(await readFile(local, 'utf8'), 'untouched local state');
  await assert.rejects(stat(join(folder, 'local-state')), { code: 'ENOENT' });
});

test('bridge resolves only the socket and ignores broken client/model settings without creating local state', async t => {
  const { folder, env } = await fixture(t);
  await writeFile(clientConfigPath(env), 'not json');
  const socket = await resolveSocketPath({}, env);
  assert.equal(socket, join(folder, 'local-state', 'chat.sqlite.sock'));
  await assert.rejects(exec(launcher, ['bridge'], { env: { ...env, PI_DURABLE_MODEL: 'invalid' } }), { stderr: /pi-durable bridge: no pi-durable server is running here: .*chat\.sqlite\.sock does not exist/ });
  const { stdout } = await exec(launcher, ['--local', '--status'], { env: { ...env, PI_DURABLE_MODEL: 'provider/model' } });
  assert.match(stdout, /No saved chat yet\./);
  await assert.rejects(stat(join(folder, 'local-state')), { code: 'ENOENT' });
});
