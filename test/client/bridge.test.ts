import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { bridge } from '../../src/client/bridge.ts';

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pd-bridge-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

function capture(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return { stream: new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    text: () => Buffer.concat(chunks).toString('utf8') };
}

async function listening(t: TestContext, onConnection: (socket: Socket) => void): Promise<string> {
  const path = join(await directory(t), 'chat.sock');
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return path;
}

test('bridge proxies raw bytes, handles EOF and leaves stdout open with no diagnostics', async t => {
  let received = '';
  const path = await listening(t, socket => {
    socket.on('data', (data: Buffer) => { received += data.toString(); socket.write(data); });
  });
  const input = new PassThrough(), output = capture(), errors = capture(), signals = new EventEmitter();
  const result = bridge(path, { stdin: input, stdout: output.stream, stderr: errors.stream, signals });
  input.end('{"t":"hello"}\nhello 🚤\n');
  assert.equal(await result, 0);
  assert.equal(received, '{"t":"hello"}\nhello 🚤\n');
  assert.equal(output.text(), received);
  assert.equal(errors.text(), '');
  assert.equal(output.stream.writableEnded, false);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('bridge refuses missing sockets and non-socket files, writing only stderr', async t => {
  const dir = await directory(t), input = new PassThrough(), output = capture(), errors = capture();
  const path = join(dir, 'not-socket');
  await writeFile(path, 'not a socket');
  assert.equal(await bridge(path, { stdin: input, stdout: output.stream, stderr: errors.stream }), 1);
  assert.match(errors.text(), /not a socket/);
  const missing = capture();
  assert.equal(await bridge(join(dir, 'missing'), { stdin: input, stdout: output.stream, stderr: missing.stream }), 1);
  // The usual cause, said plainly: no server runs for this data directory.
  assert.equal(missing.text(), `pi-durable bridge: no pi-durable server is running here: ${join(dir, 'missing')} does not exist. `
    + 'Start it with pi-durable serve (or systemctl --user start pi-durable); a server with another data directory needs --remote-data-dir.\n');
  assert.equal(output.text(), '');
});

test('bridge names a stale socket left by a server that stopped', async t => {
  const path = join(await directory(t), 'chat.sock');
  // A killed server leaves its socket file behind, with nothing listening on it.
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`]);
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'close');
  const errors = capture();
  assert.equal(await bridge(path, { stdin: new PassThrough(), stdout: capture().stream, stderr: errors.stream }), 1);
  assert.equal(errors.text(), `pi-durable bridge: no pi-durable server is running here: nothing listens on ${path} (a server that stopped left it). `
    + 'Start it with pi-durable serve (or systemctl --user start pi-durable); a server with another data directory needs --remote-data-dir.\n');
});

test('bridge signal/abort tears down the socket and restores listeners without closing stdio', async t => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const connected = Promise.withResolvers<Socket>();
    const path = await listening(t, socket => connected.resolve(socket));
    const input = new PassThrough(), output = capture(), errors = capture(), signals = new EventEmitter();
    const result = bridge(path, { stdin: input, stdout: output.stream, stderr: errors.stream, signals });
    const socket = await connected.promise;
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    signals.emit(signal);
    assert.equal(await result, code);
    await closed;
    assert.equal(input.destroyed, false);
    assert.equal(output.stream.destroyed, false);
    assert.equal(errors.text(), '');
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(name), 0);
  }
  const path = await listening(t, () => undefined);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await bridge(path, { signal: controller.signal }), 130);
});

test('bridge drains slow stdout before returning success and uses stream backpressure', async t => {
  const bytes = 2 * 1024 * 1024;
  const path = await listening(t, socket => socket.end(Buffer.alloc(bytes, 'a')));
  let received = 0, peak = 0;
  const output = new Writable({ highWaterMark: 1024, write(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    peak = Math.max(peak, output.writableLength);
    setTimeout(callback, 1);
  } });
  const input = new PassThrough(), errors = capture();
  assert.equal(await bridge(path, { stdin: input, stdout: output, stderr: errors.stream, signals: new EventEmitter() }), 0);
  assert.equal(received, bytes);
  assert.ok(peak < 256 * 1024, `bounded pipe buffer: ${peak}`);
  assert.equal(errors.text(), '');
});

test('bridge bounds a stalled final stdout drain and shuts down on output errors', async t => {
  const path = await listening(t, socket => socket.end('response'));
  const errors = capture();
  const stalled = new Writable({ write(_chunk, _encoding, _callback) {} });
  assert.equal(await bridge(path, { stdin: new PassThrough(), stdout: stalled, stderr: errors.stream,
    signals: new EventEmitter(), timeoutMs: 30 }), 1);
  assert.match(errors.text(), /stdout did not drain/);
  const failed = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('broken output')); } });
  assert.equal(await bridge(path, { stdin: new PassThrough(), stdout: failed, stderr: errors.stream,
    signals: new EventEmitter() }), 1);
  assert.match(errors.text(), /broken output/);
  assert.equal(errors.stream.destroyed, false);
  await delay(5);
});
