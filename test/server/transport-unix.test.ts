import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CloseCode, LIMITS } from '../../src/protocol/messages.ts';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { isParseError, parseServerMessage } from '../../src/protocol/parse.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';
import { adminRequest, NoServer } from '../../src/server/admin.ts';
import { Hub } from '../../src/server/hub.ts';
import { lineSplitter, listenUnix } from '../../src/server/transport-unix.ts';
import { fakeSession } from '../fixtures/server-fakes.ts';

/** A test client: the lines it got, parsed, and a way to wait for one. */
function client(path: string) {
  const socket: Socket = connect(path);
  const got: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let ended = false;
  socket.on('data', lineSplitter(Number.MAX_SAFE_INTEGER, text => {
    const message = parseServerMessage(text);
    if (isParseError(message)) throw new Error(message.message);
    got.push(message);
    for (const wake of waiters.splice(0)) wake();
  }, () => {}));
  socket.on('end', () => { ended = true; for (const wake of waiters.splice(0)) wake(); });
  const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
      if (ended) throw new Error(`connection ended; got ${JSON.stringify(got)}`);
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
  return {
    socket, got, until,
    isEnded: () => ended,
    send: (value: object | string) => socket.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`),
  };
}

async function served(t: { after: (fn: () => Promise<void>) => void }) {
  const folder = await mkdtemp(join(tmpdir(), 'pd-unix-'));
  const path = join(folder, 'chat.sqlite.sock');
  const hub = new Hub({ server: '0.1.0', boot: 'b', assets: 'a', cwd: folder, tools: { remote: 'confirm', idleMinutes: 30 },
    pushPreview: false, log: () => {},
    devices: { pair: () => Promise.resolve({ code: 'ABCD-EFGH', expiresAt: 9 }), list: () => Promise.resolve([]), revoke: () => Promise.resolve(false) } });
  hub.start(fakeSession([{ kind: 'user', id: 'e1', text: 'hi' }]));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return { folder, path, hub };
}

test('lineSplitter splits lines across chunks and skips an oversized one', () => {
  const lines: string[] = [];
  let tooLong = 0;
  const split = lineSplitter(5, line => lines.push(line), () => tooLong++);
  for (const chunk of ['ab', 'c\nde', 'f\r\n\n', '123456', '789\nok\n', 'x'.repeat(9), '\n']) split(Buffer.from(chunk));
  // A multi-byte character split across chunks is decoded whole.
  const euro = Buffer.from('€\n');
  split(euro.subarray(0, 1));
  split(euro.subarray(1));
  assert.deepEqual(lines, ['abc', 'def', 'ok', '€']);
  assert.equal(tooLong, 2);
});

test('NDJSON over a mode 600 socket: handshake, requests, an oversized line, bye on close', async t => {
  const { path, hub } = await served(t);
  const listener = await listenUnix(path, hub);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const peer = client(path);
  peer.send({ t: 'hello', protocol: PROTOCOL, client: 'test', visible: true });
  await peer.until(() => peer.got.some(m => m.t === 'ready'));
  assert.deepEqual(peer.got.map(m => m.t), ['welcome', 'status', 'snapshot', 'ready']);
  assert.equal(peer.got[0]?.t === 'welcome' && peer.got[0].peer, 'socket');

  peer.send(`{"t":"req","id":1,"op":"abort","params":{"pad":"${'x'.repeat(LIMITS.clientMessage)}"}}`);
  peer.send({ t: 'req', id: 2, op: 'memory.view', params: {} });
  await peer.until(() => peer.got.some(m => m.t === 'res' && m.id === 2));
  const answers = peer.got.filter(m => m.t === 'res');
  assert.equal(answers[0]?.t === 'res' && !answers[0].ok && answers[0].id === -1 && answers[0].error.code, 'bad_request');
  assert.equal(answers[1]?.t === 'res' && answers[1].ok && answers[1].op, 'memory.view', 'the connection survives');

  await hub.close(CloseCode.restart, 'The server is stopping.');
  await peer.until(() => peer.isEnded());
  assert.deepEqual(peer.got.at(-1), { t: 'bye', code: 1012, reason: 'The server is stopping.' });
  await listener.close();
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a stale socket is replaced; any other file is refused', async t => {
  const { folder, path, hub } = await served(t);
  // A process that dies without closing leaves its socket file behind.
  await promisify(execFile)(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`]).catch(() => {});
  assert.ok((await stat(path)).isSocket());
  await assert.rejects(adminRequest(path, { t: 'req', id: 1, op: 'admin.pair', params: {} }), NoServer);
  const listener = await listenUnix(path, hub);
  const pair = await adminRequest(path, { t: 'req', id: 1, op: 'admin.pair', params: {} });
  assert.deepEqual(pair, { t: 'res', id: 1, op: 'admin.pair', ok: true, result: { code: 'ABCD-EFGH', expiresAt: 9 } });
  const revoke = adminRequest(path, { t: 'req', id: 1, op: 'admin.revoke', params: { name: 'tablet' } });
  await assert.rejects(revoke, /No device named tablet/);
  await listener.close();
  await assert.rejects(adminRequest(path, { t: 'req', id: 1, op: 'admin.pair', params: {} }), NoServer);

  const file = join(folder, 'plain.sock');
  await writeFile(file, 'not a socket');
  await assert.rejects(listenUnix(file, hub), /is not a socket/);
});
