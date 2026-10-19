import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteSession } from '../../src/client/remote-session.ts';
import { ClientLink, ForeignSocket, unixConnector } from '../../src/client/unix-link.ts';
import type { Connector } from '../../src/client/unix-link.ts';
import { CloseCode } from '../../src/protocol/messages.ts';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { FakeServer } from '../fixtures/fake-server.ts';
import { listenFake } from './socket-server.ts';

async function until(ok: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A raw socket server whose connections the test answers by hand. */
async function rawServer(path: string, onConnection: (socket: Socket) => void): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => undefined); onConnection(socket); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

const WELCOME = JSON.stringify({ t: 'welcome', protocol: 1, server: '0.1.0', boot: 'b', assets: 'a', peer: 'socket', cwd: '/w',
  tools: { remote: 'confirm', idleMinutes: 30 } });

test('over a real socket: hello, welcome, the state, requests, and NDJSON lines split anywhere', async t => {
  const dir = await folder(t);
  const path = join(dir, 'chat.sqlite.sock');
  const fake = new FakeServer({ items: [{ kind: 'user', id: 'e1', text: 'héllo 🚤' }] });
  const listening = await listenFake(fake, path);
  t.after(() => listening.close());
  const link = new ClientLink({ connect: unixConnector(path), client: 'test' });
  const session = new RemoteSession(link);
  const welcome = await link.start();
  assert.equal(welcome.cwd, '/fake/cwd');
  await session.ready();
  assert.deepEqual(session.chat.items(), fake.rootItems());
  await session.send('count the boats 🚤');
  assert.deepEqual(fake.sends.map(sent => sent.text), ['count the boats 🚤']);
  await until(() => session.chat.items().length === 2, 'the user item');
  await session.close();
  assert.equal(link.state(), 'closed');

  // A server that writes its welcome a few bytes at a time, splitting the multibyte characters.
  const splitPath = join(dir, 'split.sock');
  const bytes = Buffer.from(`${WELCOME.replace('"/w"', '"/wé🚤"')}\n{"t":"ready"}\n`);
  const split = await rawServer(splitPath, socket => {
    socket.once('data', () => {
      void (async () => {
        for (let at = 0; at < bytes.length; at += 3) { socket.write(bytes.subarray(at, at + 3)); await delay(1); }
      })();
    });
  });
  t.after(() => split.close());
  const raw = new ClientLink({ connect: unixConnector(splitPath), client: 'test' });
  const seen: ServerMessage['t'][] = [];
  raw.onMessage(message => seen.push(message.t));
  assert.equal((await raw.start()).cwd, '/wé🚤');
  await until(() => seen.length === 2, 'ready');
  assert.deepEqual(seen, ['welcome', 'ready']);
  raw.close();
});

test('no server: a missing socket, a silent server, or a file that is not a socket', async t => {
  const dir = await folder(t);
  const missing = new ClientLink({ connect: unixConnector(join(dir, 'none.sock')), client: 'test' });
  await assert.rejects(missing.start(), /ENOENT/);
  assert.equal(missing.state(), 'closed');

  const silentPath = join(dir, 'silent.sock');
  const silent = await rawServer(silentPath, () => undefined);
  t.after(() => silent.close());
  const started = Date.now();
  await assert.rejects(new ClientLink({ connect: unixConnector(silentPath), client: 'test', helloMs: 150 }).start(), /did not answer hello/);
  assert.ok(Date.now() - started < 1000);

  const filePath = join(dir, 'file.sock');
  await writeFile(filePath, '');
  await assert.rejects(unixConnector(filePath)({ message: () => undefined, end: () => undefined }), ForeignSocket);
});

test('a welcome of another protocol, or a bye 4000 to hello, fails the first connect for good', async t => {
  const dir = await folder(t);
  const path = join(dir, 'v2.sock');
  const v2 = await rawServer(path, socket => socket.once('data', () => socket.write(`${WELCOME.replace('"protocol":1', '"protocol":2')}\n`)));
  t.after(() => v2.close());
  await assert.rejects(new ClientLink({ connect: unixConnector(path), client: 'test' }).start(), /protocol 2, this client 1/);
  const byePath = join(dir, 'bye.sock');
  const bye = await rawServer(byePath, socket => socket.once('data', () => socket.end('{"t":"bye","code":4000,"reason":"too old"}\n')));
  t.after(() => bye.close());
  await assert.rejects(new ClientLink({ connect: unixConnector(byePath), client: 'test' }).start(), /too old\. Update pi-durable/);
});

test('pings while open; a link that stays silent is dropped and reconnects', async t => {
  const dir = await folder(t);
  const path = join(dir, 'ping.sock');
  const pings: number[] = [];
  let connections = 0;
  const server = await rawServer(path, socket => {
    connections++;
    socket.setEncoding('utf8');
    let welcomed = false;
    socket.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const message: unknown = JSON.parse(line);
        if (!welcomed) { welcomed = true; socket.write(`${WELCOME}\n`); continue; }
        // Answers no ping: the client must give up on it.
        if (typeof message === 'object' && message !== null && 'n' in message && typeof message.n === 'number') pings.push(message.n);
      }
    });
  });
  t.after(() => server.close());
  const link = new ClientLink({ connect: unixConnector(path), client: 'test', pingMs: 30, retry: { first: 10, max: 10 } });
  const states: string[] = [];
  link.onChange(() => states.push(link.state()));
  await link.start();
  await until(() => connections >= 2, 'the reconnect after silence');
  assert.equal(pings[0], 0, 'pinged, counting from 0');
  assert.ok(states.includes('reconnecting'));
  link.close();
  assert.equal(link.state(), 'closed');
});

test('bye 1012 reconnects with backoff to the restarted server; bye 4001 closes for good', async t => {
  const dir = await folder(t);
  const path = join(dir, 'chat.sqlite.sock');
  const fake = new FakeServer();
  let listening = await listenFake(fake, path);
  t.after(() => listening.close());
  const link = new ClientLink({ connect: unixConnector(path), client: 'test', retry: { first: 20, max: 40 } });
  const session = new RemoteSession(link);
  await link.start();
  await session.ready();
  fake.restart();
  await listening.close();
  await until(() => link.state() === 'reconnecting', 'reconnecting');
  await delay(100);
  assert.equal(link.state(), 'reconnecting', 'still retrying while nothing listens');
  listening = await listenFake(fake, path);
  await until(() => session.attached.state() === 'open', 'reconnected');
  assert.equal(session.welcome()?.boot, fake.boot);
  const peer = fake.peers().at(-1) ?? assert.fail('no peer');
  peer.close(CloseCode.unauthorized, 'revoked');
  await until(() => link.state() === 'closed', 'closed');
  assert.match(link.closedBecause() ?? '', /refused this client: revoked/);
  await session.close();
});

test('backoff doubles from the first wait to the cap, and resets after a welcome', async () => {
  const times: number[] = [];
  let fails = 4;
  const fake = new FakeServer();
  const connect: Connector = async events => {
    times.push(Date.now());
    if (times.length > 1 && fails-- > 0) throw new Error('connect ECONNREFUSED');
    const peer = fake.connect({ send: text => setImmediate(() => events.message(text)), end: () => setImmediate(() => events.end()) });
    return { send: text => setImmediate(() => peer.handle(text)), close: () => { peer.gone(); setImmediate(() => events.end()); } };
  };
  const link = new ClientLink({ connect, client: 'test', retry: { first: 40, max: 160 }, random: () => 0.5 });
  await link.start();
  fake.peers()[0]?.drop();
  await until(() => link.state() === 'open' && times.length === 6, 'the reconnect', 5000);
  const gaps = times.slice(1).map((time, k) => time - (times[k] ?? 0));
  // Waits: 40, 80, 160, 160, 160 (the drop to the first retry, then each failure to the next).
  for (const [k, wait] of [40, 80, 160, 160, 160].entries()) {
    const gap = gaps[k] ?? assert.fail('missing attempt');
    assert.ok(gap >= wait - 5 && gap < wait + 60, `gap ${k}: ${gap} ms, expected ${wait}`);
  }
  link.close();
});
