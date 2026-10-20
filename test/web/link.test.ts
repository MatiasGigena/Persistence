import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CloseCode, LIMITS } from '../../src/protocol/messages.ts';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { backoff, Link, RequestError } from '../../src/web/link.ts';
import type { Gate, LinkState, SocketEvents } from '../../src/web/link.ts';

/** One fake WebSocket: records what the client sent, and lets the test play the server. */
class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed: number | undefined;
  readonly events: SocketEvents;
  constructor(events: SocketEvents) { this.events = events; }
  send(text: string): void {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) throw new Error('not an object');
    this.sent.push({ ...value });
  }
  close(code: number): void { this.closed = code; }
  serve(msg: object): void { this.events.message(JSON.stringify(msg)); }
  /** The server's side of a handshake. */
  handshake(): void {
    this.serve({ t: 'welcome', protocol: 1, server: '0.1.0', boot: 'b1', assets: 'a1', peer: 'web', cwd: '/w', tools: { remote: 'confirm', idleMinutes: 30 } });
    this.serve({ t: 'ready' });
  }
  last(): Record<string, unknown> | undefined { return this.sent.at(-1); }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function harness(t: TestContext, gate?: Gate) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets: FakeSocket[] = [], states: LinkState[] = [], messages: ServerMessage[] = [];
  const link = new Link({
    connect: events => { const socket = new FakeSocket(events); sockets.push(socket); return socket; },
    ...gate ? { gate } : {},
    client: 'web test', visible: () => true, random: () => 0.5,
    onMessage: msg => messages.push(msg), onState: state => states.push(state),
  });
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (!last) throw new Error('no socket yet');
    return last;
  };
  return { link, sockets, states, messages, socket };
}

test('backoff doubles from 0.5 s to 10 s with ±20% jitter', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(n => backoff(n, () => 0.5)), [500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(backoff(0, () => 0), 400);
  assert.equal(backoff(9, () => 1), 12_000);
});

test('hello, ready, requests and their answers', async t => {
  const { link, socket, states, messages } = harness(t);
  link.start();
  await flush();
  socket().events.open();
  assert.deepEqual(socket().sent[0], { t: 'hello', protocol: 1, client: 'web test', visible: true });
  await assert.rejects(link.request('models', {}), RequestError, 'no requests before ready');
  socket().handshake();
  assert.equal(link.state, 'ready');
  assert.deepEqual(states, ['ready']);
  assert.deepEqual(messages.map(m => m.t), ['welcome', 'ready']);

  const models = link.request('models', {});
  assert.deepEqual(socket().last(), { t: 'req', id: 0, op: 'models', params: {} });
  const stop = link.request('stopAgents', { name: 'Scout' });
  socket().serve({ t: 'res', id: 1, ok: false, error: { code: 'not_found', message: 'No agent named Scout.' } });
  socket().serve({ t: 'res', id: 0, op: 'models', ok: true, result: { models: [{ provider: 'p', id: 'm', name: 'M', available: true }] } });
  assert.deepEqual(await models, { models: [{ provider: 'p', id: 'm', name: 'M', available: true }] });
  await assert.rejects(stop, (error: unknown) => error instanceof RequestError && error.code === 'not_found' && error.message === 'No agent named Scout.');

  const mismatched = link.request('abort', {});
  socket().serve({ t: 'res', id: 2, op: 'models', ok: true, result: { models: [] } });
  await assert.rejects(mismatched, RequestError);
  link.visible(false);
  assert.deepEqual(socket().last(), { t: 'visible', visible: false });
  link.stop();
});

test('pings, and a silent link is dead and reconnects', async t => {
  const { link, socket, sockets, states } = harness(t);
  link.start();
  await flush();
  socket().events.open();
  socket().handshake();
  t.mock.timers.tick(LIMITS.pingMs);
  assert.deepEqual(socket().last(), { t: 'ping', n: 0 });
  socket().serve({ t: 'pong', n: 0 });
  t.mock.timers.tick(2 * LIMITS.pingMs - 1);
  assert.equal(link.state, 'ready', 'the pong kept it alive');
  const pending = link.request('abort', {});
  t.mock.timers.tick(1);
  assert.equal(link.state, 'reconnecting');
  assert.equal(sockets[0]?.closed, CloseCode.normal);
  await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'lost');
  t.mock.timers.tick(500);
  await flush();
  assert.equal(sockets.length, 2);
  socket().events.open();
  socket().handshake();
  assert.deepEqual(states, ['ready', 'reconnecting', 'ready']);
  link.stop();
});

test('backoff grows across failed attempts and resets after ready', async t => {
  const { link, socket, sockets } = harness(t);
  link.start();
  await flush();
  socket().events.close(1006);
  for (const delay of [500, 1000, 2000]) {
    const before = sockets.length;
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(sockets.length, before, `not before ${delay} ms`);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(sockets.length, before + 1, `after ${delay} ms`);
    socket().events.close(1006);
  }
  t.mock.timers.tick(4000);
  await flush();
  socket().events.open();
  socket().handshake();
  socket().events.close(CloseCode.restart);
  const before = sockets.length;
  t.mock.timers.tick(500);
  await flush();
  assert.equal(sockets.length, before + 1, 'back to 0.5 s after a ready');
  link.stop();
});

test('bye 4000 and 4001 close for good; other codes reconnect', async t => {
  for (const [code, why] of [[CloseCode.version, 'version'], [CloseCode.unauthorized, 'unauthorized']] as const) {
    const { link, socket, sockets } = harness(t);
    link.start();
    await flush();
    socket().events.open();
    socket().handshake();
    socket().serve({ t: 'bye', code, reason: 'go away' });
    socket().events.close(code);
    assert.equal(link.state, 'closed');
    assert.equal(link.closedBy, why);
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(sockets.length, 1);
    t.mock.timers.reset();
  }
  const { link, socket } = harness(t);
  link.start();
  await flush();
  socket().events.open();
  socket().handshake();
  socket().serve({ t: 'bye', code: CloseCode.tooSlow, reason: 'slow' });
  socket().events.close(CloseCode.tooSlow);
  assert.equal(link.state, 'reconnecting');
  link.stop();
  assert.equal(link.state, 'closed');
  assert.equal(link.closedBy, 'stopped');
});

test('the gate: offline retries, unpaired stops, poke retries at once', async t => {
  let answer: Awaited<ReturnType<Gate>> = 'offline';
  const { link, sockets, states } = harness(t, () => Promise.resolve(answer));
  link.start();
  await flush();
  assert.equal(link.state, 'offline');
  assert.equal(sockets.length, 0);
  answer = 'ok';
  link.poke();
  await flush();
  assert.equal(sockets.length, 1);
  sockets[0]?.events.close(1006);
  answer = 'unpaired';
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(link.state, 'closed');
  assert.equal(link.closedBy, 'unpaired');
  assert.deepEqual(states, ['offline', 'reconnecting', 'closed']);
});

test('events from an abandoned socket are ignored', async t => {
  const { link, socket, sockets, messages } = harness(t);
  link.start();
  await flush();
  const first = socket();
  first.events.open();
  first.events.close(1006);
  t.mock.timers.tick(500);
  await flush();
  first.handshake();
  assert.equal(messages.length, 0);
  assert.equal(sockets.length, 2);
  link.stop();
});

// A phone that sleeps freezes the page: sockets and fetches started around the sleep can hang without ever opening,
// closing or failing, and the socket that was open is usually dead on waking.

test('an attempt that never opens is abandoned after connectMs, and the link retries', async t => {
  const { link, sockets, states } = harness(t);
  link.start();
  await flush();
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(LIMITS.connectMs - 1);
  assert.equal(link.state, 'connecting', 'still waiting');
  t.mock.timers.tick(1);
  assert.equal(sockets[0]?.closed, CloseCode.normal);
  assert.deepEqual(states, ['reconnecting']);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(sockets.length, 2);
  link.stop();
});

test('a gate that never answers counts as offline after connectMs', async t => {
  const { link, sockets } = harness(t, () => new Promise(() => undefined));
  link.start();
  await flush();
  t.mock.timers.tick(LIMITS.connectMs);
  await flush();
  assert.equal(link.state, 'offline');
  assert.equal(sockets.length, 0);
  link.stop();
});

test('poke while an attempt hangs starts a fresh one at once, with the backoff reset', async t => {
  const { link, sockets } = harness(t);
  link.start();
  await flush();
  for (let i = 0; i < 3; i++) {
    sockets.at(-1)?.events.close(1006);
    t.mock.timers.tick(10_000);
    await flush();
  }
  const hung = sockets.at(-1);
  assert.equal(sockets.length, 4);
  link.poke(); // the app came back to the front
  await flush();
  assert.equal(hung?.closed, CloseCode.normal, 'the hung attempt is closed');
  assert.equal(sockets.length, 5);
  sockets.at(-1)?.events.open();
  sockets.at(-1)?.handshake();
  assert.equal(link.state, 'ready');
  link.stop();
});

test('poke while ready checks the link: a dead socket is dropped within wakeMs, a live one stays', async t => {
  const { link, socket, sockets } = harness(t);
  link.start();
  await flush();
  socket().events.open();
  socket().handshake();
  link.poke();
  assert.deepEqual(socket().last(), { t: 'ping', n: 0 });
  socket().serve({ t: 'pong', n: 0 });
  t.mock.timers.tick(LIMITS.wakeMs);
  assert.equal(link.state, 'ready', 'it answered');
  link.poke();
  t.mock.timers.tick(LIMITS.wakeMs);
  assert.equal(link.state, 'reconnecting', 'no answer: dead');
  assert.equal(sockets[0]?.closed, CloseCode.normal);
  link.stop();
});
