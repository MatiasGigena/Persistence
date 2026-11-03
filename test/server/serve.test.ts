import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseArgs, resolveOptions, statePaths } from '../../src/host/config.ts';
import type { ChatItem, ServerMessage } from '../../src/protocol/messages.ts';
import { applyOps } from '../../src/protocol/mirror.ts';
import { isParseError, parseServerMessage } from '../../src/protocol/parse.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';
import { lineSplitter } from '../../src/server/transport-unix.ts';
import { serve } from '../../src/server/serve.ts';
import { Devices } from '../../src/server/auth.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const exec = promisify(execFile);

/** Waits until `done` holds, polling; fails with `what` after `ms`. */
async function until(done: () => boolean, what: () => string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A loopback port nothing listens on just now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return typeof address === 'object' && address ? address.port : assert.fail('no port');
}

test('serve end to end: a socket client sends, watches the reply stream in, and gets bye 1012 on SIGTERM', { timeout: 60_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-serve-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { model } = offlineModels();
  const config = await resolveOptions(parseArgs(['serve', '--database', join(folder, 'chat.sqlite'), '--cwd', folder,
    '--model', `${model.provider}/${model.modelId}`]), { PI_DURABLE_TOOLS_IDLE_MIN: '5' });
  const socketPath = config.socketPath ?? assert.fail('no socket path');
  const child = spawn(process.execPath, [resolve('test/fixtures/serve-faux.ts'), JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let log = '';
  child.stderr.on('data', chunk => { log += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  await until(() => log.includes('ready:'), () => log);
  assert.match(log, /web app off: set PI_DURABLE_ORIGIN/);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

  const socket = connect(socketPath);
  const got: ServerMessage[] = [];
  let mirror: ChatItem[] = [], resyncs = 0;
  socket.on('data', lineSplitter(Number.MAX_SAFE_INTEGER, text => {
    const message = parseServerMessage(text);
    if (isParseError(message)) throw new Error(message.message);
    got.push(message);
    if (message.t === 'snapshot' && message.feed === 'root') mirror = [...message.items];
    if (message.t === 'items' && message.feed === 'root') {
      const next = applyOps(mirror, message.ops);
      if (next === 'resync') resyncs++;
      else mirror = next;
    }
  }, () => {}));
  const send = (value: object): void => { socket.write(`${JSON.stringify(value)}\n`); };
  send({ t: 'hello', protocol: PROTOCOL, client: 'serve.test', visible: true });
  await until(() => got.some(m => m.t === 'ready'), () => JSON.stringify(got));
  const welcome = got[0];
  assert.equal(welcome?.t, 'welcome');
  assert.deepEqual(welcome?.t === 'welcome' && { peer: welcome.peer, cwd: welcome.cwd, tools: welcome.tools },
    { peer: 'socket', cwd: folder, tools: { remote: 'confirm', idleMinutes: 5 } });
  const status = got.find(m => m.t === 'status');
  assert.equal(status?.t === 'status' && status.status.toolsEnabled, true, 'a server starts with tools on');

  send({ t: 'req', id: 1, op: 'send', params: { text: 'How many boats?', requestId: 'serve-test-1' } });
  const answer = 'There are three boats in the harbour, all of them blue.';
  await until(() => mirror.some(item => item.kind === 'assistant' && item.text === answer && !item.streaming), () => JSON.stringify(mirror));
  assert.deepEqual(got.find(m => m.t === 'res' && m.id === 1), { t: 'res', id: 1, op: 'send', ok: true, result: null });
  assert.ok(mirror.some(item => item.kind === 'user' && item.text === 'How many boats?'));
  assert.ok(got.some(m => m.t === 'items' && m.ops.some(op => op.op === 'append')), 'the reply streamed as appends');
  assert.equal(resyncs, 0);

  // An online backup while the server runs, through the backup command's socket path.
  const backups = join(folder, 'backups');
  const env = { ...process.env, PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json'), PI_DURABLE_REMOTE: '' };
  const { stdout } = await exec(process.execPath, [resolve('src/cli.ts'), 'backup', '--database', join(folder, 'chat.sqlite'), '--out', backups], { env });
  assert.match(stdout, /Backup written by the server: .*backups\/\d{4}-\d{2}-\d{2}T/);
  // With the web app off, a pairing code would have nowhere to go: the server says why instead.
  await assert.rejects(exec(process.execPath, [resolve('src/cli.ts'), 'serve', 'pair', '--database', join(folder, 'chat.sqlite')], { env }),
    { code: 1, stderr: /The web app is off: set PI_DURABLE_ORIGIN and PI_DURABLE_ALLOW_LOGIN/ });
  const [dir] = await readdir(backups);
  assert.deepEqual((await readdir(join(backups, dir ?? ''))).sort(), ['chat.sqlite', 'chat.unii'], 'no settings.json yet');

  const ended = new Promise<void>(resolve => socket.once('end', () => resolve()));
  child.kill('SIGTERM');
  await ended;
  assert.deepEqual(got.at(-1), { t: 'bye', code: 1012, reason: 'The server is stopping.' });
  assert.equal(await exited, 143, log);
  await assert.rejects(stat(socketPath), { code: 'ENOENT' }, 'the socket is removed');
});

test('the launcher runs serve under the flock, serves the admin commands, and stops on SIGTERM', { timeout: 60_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-launch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const launcher = resolve('bin/pi-durable');
  // The web listener is on (loopback, on a free port), so `serve pair` has somewhere to send a device.
  const port = await freePort();
  const env = { ...process.env, PI_DURABLE_DATA_DIR: join(folder, 'state'), OPENAI_API_KEY: 'offline-placeholder-not-a-real-key',
    PI_DURABLE_ORIGIN: `http://127.0.0.1:${port}`, PI_DURABLE_ALLOW_LOGIN: 'me@example.com', PI_DURABLE_PORT: String(port),
    PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json'), PI_DURABLE_REMOTE: '' };
  const base = ['--model', 'openai/gpt-4o-mini', '--auth-file', join(folder, 'auth.json'), '--cwd', folder];
  await assert.rejects(exec(launcher, ['serve', 'pair'], { env }), { code: 1, stderr: /No server is running for this chat/ });
  await assert.rejects(exec(launcher, ['backup'], { env }), { code: 1, stderr: /No saved chat to back up/ });
  const child = spawn(launcher, ['serve', ...base], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  t.after(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  let log = '';
  child.stderr.on('data', chunk => { log += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  await until(() => log.includes('ready:'), () => log);

  await assert.rejects(exec(launcher, ['serve', ...base], { env }), { code: 75, stderr: /A server runs this chat|already open/ });
  const { stdout: pair } = await exec(launcher, ['serve', 'pair'], { env });
  assert.match(pair, /^Pairing code: [0-9A-Z]{4}-[0-9A-Z]{4}$/m);
  assert.match(pair, new RegExp(`^Enter it in the web app at http://127\\.0\\.0\\.1:${port} with a name`, 'm'), 'it says where to enter the code');
  const { stdout: devices } = await exec(launcher, ['serve', 'devices'], { env });
  assert.match(devices, /No paired devices/);
  await assert.rejects(exec(launcher, ['serve', 'devices', '--revoke', 'tablet'], { env }), { code: 1, stderr: /No device named tablet\. No device is paired\./ });
  const { stdout: backedUp } = await exec(launcher, ['backup'], { env });
  assert.match(backedUp, /Backup written by the server: .*state\/backups\//);

  child.kill('SIGTERM');
  assert.equal(await exited, 143, log);
  assert.match(log, /stopping/);
  // Without a server, backup takes the flock and writes it itself.
  const { stdout: offline } = await exec(launcher, ['backup'], { env });
  assert.match(offline, /^Backup written: .*state\/backups\//m);
});

// Web initialization creates VAPID state; it must not run for a chat that never opened.
test('a failed instance open does not start web initialization', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-serve-failed-open-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, 'invalid.sqlite');
  await writeFile(databasePath, 'not a SQLite database');
  const { models, model } = offlineModels();
  const config = await resolveOptions(parseArgs(['serve', '--database', databasePath, '--cwd', folder,
    '--model', `${model.provider}/${model.modelId}`]), {
    PI_DURABLE_ORIGIN: 'http://localhost:4783', PI_DURABLE_ALLOW_LOGIN: 'me@example.com',
  });
  const devices = t.mock.method(Devices, 'open');
  await assert.rejects(serve(config, { models, signal: new AbortController().signal, log: () => {} }));
  assert.equal(devices.mock.callCount(), 0);
  await assert.rejects(stat(statePaths(databasePath).vapid), { code: 'ENOENT' });
});

test('an already-aborted server does not start web initialization', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pd-serve-aborted-open-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, 'chat.sqlite');
  const { models, model } = offlineModels();
  const config = await resolveOptions(parseArgs(['serve', '--database', databasePath, '--cwd', folder,
    '--model', `${model.provider}/${model.modelId}`]), {
    PI_DURABLE_ORIGIN: 'http://localhost:4783', PI_DURABLE_ALLOW_LOGIN: 'me@example.com',
  });
  const devices = t.mock.method(Devices, 'open');
  await serve(config, { models, signal: AbortSignal.abort(), log: () => {} });
  assert.equal(devices.mock.callCount(), 0);
  await assert.rejects(stat(statePaths(databasePath).vapid), { code: 'ENOENT' });
});
