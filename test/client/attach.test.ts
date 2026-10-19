import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { attachChat, DETACHED, probes, SERVER_RUNS } from '../../src/client/attach.ts';
import { parseArgs, resolveOptions } from '../../src/host/config.ts';
import type { Config } from '../../src/host/config.ts';
import { CloseCode } from '../../src/protocol/messages.ts';
import { LINK_CLOSED } from '../../src/ui/tui/app.ts';
import { FakeServer } from '../fixtures/fake-server.ts';
import { listenFake } from './socket-server.ts';

const exec = promisify(execFile);
const launcher = resolve('bin/pi-durable');
const TTY = { stdin: true, stdout: true } as const;

/** Enough of a terminal for the TUI: it records output and takes typed keys. */
class FakeTerminal implements Terminal {
  output = '';
  readonly columns = 80;
  readonly rows = 24;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  type(...keys: string[]): void {
    if (!this.onInput) throw new Error('terminal not started');
    for (const key of keys) for (const data of key.length > 1 && !key.startsWith('\x1b') ? [...key] : [key]) this.onInput(data);
  }
  text(): string { return stripTerminalSequences(this.output); }
}

async function until(ok: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

async function chat(t: { after: (fn: () => Promise<void>) => void }, args: string[] = []): Promise<{ dir: string; config: Config; socket: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-attach-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = await resolveOptions(parseArgs(['--data-dir', dir, ...args]), {});
  return { dir, config, socket: config.socketPath ?? assert.fail('no socket path') };
}

test('only an interactive full-screen launch probes', async t => {
  const { dir } = await chat(t);
  const config = async (...args: string[]): Promise<Config> => resolveOptions(parseArgs(['--data-dir', dir, ...args]), {});
  assert.equal(probes(await config(), TTY), true);
  for (const args of [['--local'], ['--plain'], ['-p', 'x'], ['--status'], ['--history'], ['--resume'], ['hello']]) {
    assert.equal(probes(await config(...args), TTY), false, args.join(' '));
  }
  assert.equal(probes(await config(), { stdin: false, stdout: true }), false, 'piped stdin');
  assert.equal(probes(await config(), { stdin: true, stdout: false }), false, 'stdout not a terminal');
  assert.equal(probes({ ...await config(), socketPath: undefined }, TTY), false, 'no socket path');
});

test('no server: the probe falls through to the local path, and --attach fails', async t => {
  const { config, socket } = await chat(t);
  assert.equal(await attachChat(config, { tty: TTY }), undefined, 'no socket file');
  await assert.rejects(attachChat({ ...config, attach: true }, { tty: TTY }), new RegExp(`No server answers at ${socket}`));

  // A stale socket: its server was killed without removing it.
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`]);
  await new Promise(done => child.stdout.once('data', done));
  child.kill('SIGKILL');
  await new Promise(done => child.once('close', done));
  let started = Date.now();
  assert.equal(await attachChat(config, { tty: TTY }), undefined, 'a stale socket');
  assert.ok(Date.now() - started < 500, 'refused at once');

  // A server that never says welcome: the probe gives up after 1.5 s.
  await rm(socket);
  const connections: Socket[] = [];
  const silent = createServer(connection => { connections.push(connection); });
  await new Promise<void>(done => silent.listen(socket, done));
  t.after(() => new Promise<void>(done => { for (const each of connections) each.destroy(); silent.close(() => done()); }));
  started = Date.now();
  assert.equal(await attachChat({ ...config }, { tty: TTY }), undefined, 'a silent server');
  assert.ok(Date.now() - started >= 1400, 'waited for the welcome');
});

test('a server answers: the TUI runs on it, sends reach it, and detaching leaves it running', async t => {
  const { config, socket } = await chat(t);
  const fake = new FakeServer({ items: [{ kind: 'assistant', id: 'e1', text: 'Welcome back', streaming: false }] });
  const listening = await listenFake(fake, socket);
  t.after(() => listening.close());
  const terminal = new FakeTerminal();
  const printed: string[] = [];
  const stop = new AbortController();
  t.after(() => { stop.abort(); return Promise.resolve(); });
  const done = attachChat(config, { tty: TTY, terminal, env: {}, signal: stop.signal, print: line => printed.push(line) });
  await until(() => terminal.text().includes('Welcome back'), 'the chat');
  terminal.type('count the boats', '\r');
  await until(() => fake.sends.length === 1, 'the send');
  assert.equal(fake.sends[0]?.text, 'count the boats');
  await until(() => terminal.text().includes('count the boats'), 'the user item');
  fake.setStatus({ busy: true });
  terminal.type('\x04');
  assert.equal(await done, 0);
  assert.deepEqual(printed, [DETACHED]);
  assert.doesNotMatch(terminal.text(), /Exit anyway/, 'no confirmation while the server works');
  await until(() => fake.peers().length === 0, 'the peer gone');
  assert.equal(listening.server.listening, true, 'the server keeps running');
});

test('a probed attach refuses launch settings; a server that closes the link for good ends the TUI', async t => {
  const { dir, socket } = await chat(t);
  const fake = new FakeServer();
  const listening = await listenFake(fake, socket);
  t.after(() => listening.close());
  const withModel = await resolveOptions(parseArgs(['--data-dir', dir, '--model', 'a/b']), {});
  await assert.rejects(attachChat(withModel, { tty: TTY }), /--model does not apply: a server runs this chat/);
  await until(() => fake.peers().length === 0, 'the probe closed');

  const config = await resolveOptions(parseArgs(['--data-dir', dir]), {});
  const terminal = new FakeTerminal();
  const printed: string[] = [];
  const stop = new AbortController();
  t.after(() => { stop.abort(); return Promise.resolve(); });
  const done = attachChat(config, { tty: TTY, terminal, env: {}, signal: stop.signal, print: line => printed.push(line) });
  await until(() => fake.peers().length === 1 && fake.peers()[0]?.ready === true, 'attached');
  fake.peers()[0]?.close(CloseCode.unauthorized, 'revoked');
  assert.equal(await done, 1);
  assert.deepEqual(printed, [], 'no "Detached" line: the notice said it');
  const words = (text: string): string => text.replace(/[\s!│]+/g, ' ');
  assert.ok(words(terminal.text()).includes(words(LINK_CLOSED)));
  assert.match(terminal.text(), /refused this client: revoked/);
});

test('the launcher: --attach without a server fails; a busy lock with a server answering says to attach', async t => {
  const { dir, socket, config } = await chat(t);
  const env = { ...process.env, PI_DURABLE_DATA_DIR: dir };
  await assert.rejects(exec(launcher, ['--attach'], { env }), { code: 1, stderr: new RegExp(`pi-durable: No server answers at ${socket}`) });

  // Holds the chat's flock, as a server would; its own process group, so the sleep goes with it.
  const holder = spawn('flock', [`${config.databasePath}.lock`, '-c', 'echo held; exec sleep 30'], { detached: true });
  t.after(() => { if (holder.pid !== undefined) process.kill(-holder.pid, 'SIGKILL'); return Promise.resolve(); });
  await new Promise(done => holder.stdout.once('data', done));
  holder.stdout.destroy();
  await assert.rejects(exec(launcher, ['--local'], { env }), { code: 75, stderr: /already open in another pi-durable process/ });
  const fake = new FakeServer();
  const listening = await listenFake(fake, socket);
  t.after(() => listening.close());
  await assert.rejects(exec(launcher, ['--local'], { env }), { code: 75, stderr: new RegExp(SERVER_RUNS.replace(/[`.]/g, '\\$&')) });
  await assert.rejects(exec(launcher, ['-p', 'hello'], { env }), { code: 75, stderr: new RegExp(SERVER_RUNS.replace(/[`.]/g, '\\$&')) });
});
