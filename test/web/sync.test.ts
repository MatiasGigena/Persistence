// The web client's link and store against test/fixtures/fake-server.ts: a send survives a reconnect exactly once,
// agent feeds reopen by name, a server restart asks for a reload, and an op that does not fit resyncs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CloseCode } from '../../src/protocol/messages.ts';
import { Link } from '../../src/web/link.ts';
import type { LinkState, SocketHandle } from '../../src/web/link.ts';
import { Store } from '../../src/web/store.ts';
import type { Effect } from '../../src/web/store.ts';
import { FakeServer } from '../fixtures/fake-server.ts';

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A web client (Link + Store) wired to `server` through an in-memory socket. */
function client(t: TestContext, server: FakeServer) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const store = new Store();
  const effects: Effect[] = [];
  const states: LinkState[] = [];
  let drop: (() => void) | undefined;
  const link = new Link({
    client: 'web test', visible: () => false, random: () => 0.5,
    connect: events => {
      let open = true;
      const end = (code: number): void => { if (open) { open = false; events.close(code); } };
      // Messages are delivered on a later microtask, as a socket would, so requests made in handlers interleave right.
      const peer = server.connect({
        peer: 'web', device: 'phone',
        send: text => queueMicrotask(() => { if (open) events.message(text); }),
        end: () => queueMicrotask(() => end(CloseCode.restart)),
      });
      drop = () => { peer.gone(); end(1006); };
      queueMicrotask(() => events.open());
      const socket: SocketHandle = {
        send: text => { if (open) peer.handle(text); },
        close: () => { peer.gone(); end(CloseCode.normal); },
      };
      return socket;
    },
    onMessage: msg => { effects.push(...store.handle(msg)); },
    onState: state => states.push(state),
  });
  return { store, link, effects, states, drop: () => drop?.() };
}

test('a send is shown pending, then once in the feed, even when resent after a drop', async t => {
  const server = new FakeServer({ items: [{ kind: 'user', id: 'u0', text: 'earlier' }] });
  const { store, link, drop } = client(t, server);
  link.start();
  await flush();
  assert.equal(link.state, 'ready');
  assert.deepEqual(store.rootView().map(i => i.id), ['u0']);

  server.hold('send');
  store.addPending('rid-1', 'count the boats');
  const first = link.request('send', { text: 'count the boats', requestId: 'rid-1' });
  await flush();
  assert.equal(store.rootView().at(-1)?.kind, 'pending');
  drop();
  await assert.rejects(first, { code: 'lost' });
  server.release('send');
  t.mock.timers.tick(500);
  await flush();
  assert.equal(link.state, 'ready');
  await link.request('send', { text: 'count the boats', requestId: 'rid-1' });
  store.admitPending('rid-1');
  await flush();
  assert.deepEqual(server.sends.map(s => s.text), ['count the boats'], 'admitted once');
  assert.deepEqual(store.rootView().map(i => i.kind), ['user', 'user'], 'the pending item gave way to the real one');
  link.stop();
});

test('agent feeds reopen after a restart, which is noted', async t => {
  const server = new FakeServer({ agents: { Scout: [{ kind: 'user', id: 's1', text: 'task' }] } });
  const { store, link, effects } = client(t, server);
  link.start();
  await flush();
  const { feed } = await link.request('feed.open', { name: 'scout' });
  store.openAgent(feed, 'Scout');
  await flush();
  assert.deepEqual(store.agentByName('Scout')?.agent.mirror.items.map(i => i.id), ['s1']);

  server.restart();
  await flush();
  assert.equal(link.state, 'reconnecting');
  const names = store.disconnect();
  assert.deepEqual(names, ['Scout']);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(link.state, 'ready');
  assert.ok(!effects.some(e => e.t === 'reload'), 'same assets: no reload');
  assert.ok(store.rootView().some(i => i.kind === 'notice' && i.text === 'The server restarted.'));
  const again = await link.request('feed.open', { name: 'Scout' });
  store.openAgent(again.feed, 'Scout');
  server.setAgentItems('Scout', [{ kind: 'user', id: 's1', text: 'task' }, { kind: 'assistant', id: 's2', text: 'done', streaming: false }]);
  await flush();
  assert.deepEqual(store.agentByName('Scout')?.agent.mirror.items.map(i => i.id), ['s1', 's2']);
  server.removeAgent('Scout');
  await flush();
  assert.equal(store.agentByName('Scout')?.agent.ended, 'The agent is gone');
  link.stop();
});

test('an op that does not fit is resynced with a fresh snapshot', async t => {
  const server = new FakeServer({ items: [{ kind: 'user', id: 'u1', text: 'hi' }] });
  const { store, link, effects } = client(t, server);
  link.start();
  await flush();
  const [peer] = server.peers();
  peer?.push({ t: 'items', feed: 'root', ops: [{ op: 'append', id: 'u1', field: 'text', at: 7, text: '!' }] });
  await flush();
  const resync = effects.find(e => e.t === 'resync');
  assert.deepEqual(resync, { t: 'resync', feed: 'root' });
  server.setItems([{ kind: 'user', id: 'u1', text: 'hi' }, { kind: 'user', id: 'u2', text: 'there' }]);
  await flush();
  assert.equal(store.root.items.length, 1, 'items wait for the snapshot');
  await link.request('feed.resync', { feed: 'root' });
  await flush();
  assert.deepEqual(store.root.items.map(i => i.id), ['u1', 'u2']);
  link.stop();
});

test('tools need the confirmation, and a revoked device stops the link', async t => {
  const server = new FakeServer();
  const { store, link, states } = client(t, server);
  link.start();
  await flush();
  await assert.rejects(link.request('tools.set', { enabled: true }), { code: 'bad_request' });
  await link.request('tools.set', { enabled: true, confirm: 'enable-tools' });
  await flush();
  assert.equal(store.status?.toolsEnabled, true);
  assert.ok(store.rootView().some(i => i.kind === 'notice' && i.text.includes('Coding tools on')));
  server.peers()[0]?.close(CloseCode.unauthorized, 'This device was revoked');
  await flush();
  assert.equal(link.state, 'closed');
  assert.equal(link.closedBy, 'unauthorized');
  assert.deepEqual(states, ['ready', 'closed']);
});
