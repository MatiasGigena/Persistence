import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CloseCode, LIMITS } from '../../src/protocol/messages.ts';
import type { ChatItem, ServerMessage } from '../../src/protocol/messages.ts';
import { MAX_IN_FLIGHT, SILENCE_MS, STATUS_MS } from '../../src/server/connection.ts';
import { Hub, PUSH_EVERY_MS, VISIBLE_MS } from '../../src/server/hub.ts';
import type { HubOptions } from '../../src/server/hub.ts';
import type { DeviceRegistry } from '../../src/server/link.ts';
import { fakeLink, fakePush, fakeSession, FakeFeed } from '../fixtures/server-fakes.ts';
import type { FakeLink } from '../fixtures/server-fakes.ts';

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text });
const said = (id: string, text: string, streaming = false): ChatItem => ({ kind: 'assistant', id, text, streaming });
const types = (link: FakeLink): string[] => link.got.map(message => message.t);
const last = (link: FakeLink): ServerMessage | undefined => link.got.at(-1);
const phone = { name: 'phone', pairedAt: 1 };

function setup(t: TestContext, options: Partial<HubOptions> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const logged: string[] = [];
  const hub = new Hub({ server: '0.1.0', boot: 'boot1', assets: 'a1', cwd: '/work', tools: { remote: 'confirm', idleMinutes: 30 },
    pushPreview: false, log: line => logged.push(line), ...options });
  const session = fakeSession([user('e1', 'hi'), said('e2', 'Hello!')]);
  // Mock timers move Date.now() to the end of a tick before running its callbacks: step in seconds.
  const tick = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 1_000) { t.mock.timers.tick(Math.min(1_000, left)); await settle(); }
  };
  /** Time passes while `links` ping as clients do. */
  const wait = async (ms: number, ...links: FakeLink[]): Promise<void> => {
    for (let left = ms; left > 0; left -= LIMITS.pingMs) {
      for (const link of links) link.deliver({ t: 'ping', n: 0 });
      await tick(Math.min(LIMITS.pingMs, left));
    }
  };
  /** A link that said hello and got the initial state; its messages so far are cleared. */
  const connect = (peer: 'socket' | 'web' = 'socket', visible = false): FakeLink => {
    const link = fakeLink(peer, peer === 'web' ? phone : undefined);
    hub.attach(link);
    link.hello(visible);
    link.got.length = 0;
    return link;
  };
  let id = 0;
  const request = async (link: FakeLink, op: string, params: object = {}): Promise<ServerMessage | undefined> => {
    const n = ++id;
    link.deliver({ t: 'req', id: n, op, params });
    await settle();
    return link.got.find(message => message.t === 'res' && message.id === n);
  };
  return { hub, session, logged, tick, wait, connect, request };
}

test('hello gets welcome, status, the root snapshot and ready, in order', t => {
  const { hub, session } = setup(t);
  hub.start(session);
  const link = fakeLink('web', phone);
  hub.attach(link);
  link.hello(true);
  assert.deepEqual(types(link), ['welcome', 'status', 'snapshot', 'ready']);
  const [welcome, status, snapshot] = link.got;
  assert.deepEqual(welcome, { t: 'welcome', protocol: 1, server: '0.1.0', boot: 'boot1', assets: 'a1', peer: 'web', cwd: '/work',
    tools: { remote: 'confirm', idleMinutes: 30 }, device: 'phone' });
  assert.equal(status?.t === 'status' && status.status.model, 'faux/faux-1');
  assert.deepEqual(snapshot, { t: 'snapshot', feed: 'root', items: session.root.list });
});

test('before the session is up a peer gets welcome only; start() brings the rest', async t => {
  const { hub, session, request } = setup(t);
  const link = fakeLink();
  hub.attach(link);
  link.hello();
  assert.deepEqual(types(link), ['welcome']);
  const early = await request(link, 'abort');
  assert.equal(early?.t === 'res' && !early.ok && early.error.code, 'unavailable');
  hub.start(session);
  assert.deepEqual(types(link).slice(1), ['res', 'status', 'snapshot', 'ready']);
});

test('a wrong protocol, a missing hello, or a request before hello', async t => {
  const { hub, session, tick, request } = setup(t);
  hub.start(session);
  const wrong = fakeLink();
  hub.attach(wrong);
  wrong.deliver({ t: 'hello', protocol: 99, client: 'old', visible: false });
  assert.deepEqual(types(wrong), ['bye']);
  assert.equal(wrong.closedWith?.code, CloseCode.version);

  const early = fakeLink();
  hub.attach(early);
  const res = await request(early, 'abort');
  assert.equal(res?.t === 'res' && !res.ok && res.error.code, 'version');
  early.deliver({ t: 'ping', n: 1 });
  assert.deepEqual(types(early), ['res'], 'ping before hello is ignored');

  const silent = fakeLink();
  hub.attach(silent);
  await tick(LIMITS.helloMs);
  assert.equal(silent.closedWith?.code, CloseCode.version);
  assert.equal(session.calls.length, 0);
});

test('feed changes go as item ops within flushMs: puts with before, appends, then a snapshot on reorder', async t => {
  const { hub, session, tick, connect } = setup(t);
  hub.start(session);
  const link = connect();
  session.root.set([...session.root.list, said('live1', 'Th', true)]);
  session.root.set([...session.root.list.slice(0, 2), said('live1', 'There', true)]);
  assert.equal(link.got.length, 0, 'nothing before the flush');
  await tick(LIMITS.flushMs);
  assert.deepEqual(link.got, [{ t: 'items', feed: 'root', ops: [{ op: 'put', item: said('live1', 'There', true) }] }]);
  session.root.set([user('e1', 'hi'), said('e2', 'Hello!'), said('live1', 'There are 3.', true)]);
  await tick(LIMITS.flushMs);
  assert.deepEqual(last(link), { t: 'items', feed: 'root', ops: [{ op: 'append', id: 'live1', field: 'text', at: 5, text: ' are 3.' }] });
  session.root.set([user('e1', 'hi'), user('e3', 'retry'), said('e2', 'Hello!'), said('live1', 'There are 3.', true)]);
  await tick(LIMITS.flushMs);
  assert.deepEqual(last(link), { t: 'items', feed: 'root', ops: [{ op: 'put', item: user('e3', 'retry'), before: 'e2' }] });
  session.root.set([said('e2', 'Hello!'), user('e1', 'hi')]);
  await tick(LIMITS.flushMs);
  assert.equal(last(link)?.t, 'snapshot');
});

test('requests: send with requestId, errors, unknown ops, malformed messages, ping', async t => {
  const { hub, session, connect, request } = setup(t);
  hub.start(session);
  const link = connect();
  assert.deepEqual(await request(link, 'send', { text: 'count the boats', requestId: 'tui-1' }), { t: 'res', id: 1, op: 'send', ok: true, result: null });
  assert.deepEqual(session.calls, ['send count the boats tui-1']);
  const empty = await request(link, 'send', { text: '  ' });
  assert.equal(empty?.t === 'res' && !empty.ok && empty.error.code, 'bad_request');
  const unknown = await request(link, 'teleport');
  assert.equal(unknown?.t === 'res' && !unknown.ok && unknown.error.code, 'unknown_op');
  const missing = await request(link, 'feed.open', {});
  assert.equal(missing?.t === 'res' && !missing.ok && missing.error.code, 'bad_request');
  link.deliver('{not json');
  const garbled = last(link);
  assert.equal(garbled?.t === 'res' && garbled.id, -1);
  link.deliver({ t: 'future-thing' });
  assert.equal(last(link), garbled, 'an unknown type is ignored');
  assert.deepEqual(await request(link, 'stopAgents', { name: 'Ada' }), { t: 'res', id: 5, op: 'stopAgents', ok: true, result: { names: ['Ada'] } });
  assert.deepEqual(await request(link, 'memory.view'), { t: 'res', id: 6, op: 'memory.view', ok: true, result: { lines: [{ id: 0, n: 1, text: 'hello' }] } });
  const zoom = await request(link, 'memory.zoom', { id: 8, n: 1 });
  assert.equal(zoom?.t === 'res' && !zoom.ok && zoom.error.code, 'not_found');
  const model = await request(link, 'model.set', { provider: 'nope', id: 'x' });
  assert.deepEqual(model?.t === 'res' && !model.ok && model.error, { code: 'failed', message: 'Unknown model nope/x' });
  link.deliver({ t: 'ping', n: 7 });
  assert.deepEqual(last(link), { t: 'pong', n: 7 });
});

test('socket-only and web-only ops are forbidden to the other peer', async t => {
  const devices: DeviceRegistry = {
    pair: () => Promise.resolve({ code: 'ABCD-EFGH', expiresAt: 5 }),
    list: () => Promise.resolve([phone]),
    revoke: name => Promise.resolve(name === 'phone'),
  };
  const push = fakePush();
  const { hub, session, connect, request } = setup(t, { devices, push });
  hub.start(session);
  const web = connect('web'), socket = connect('socket');
  for (const op of ['admin.backup', 'admin.pair', 'admin.devices', 'admin.revoke']) {
    const res = await request(web, op, { name: 'phone' });
    assert.equal(res?.t === 'res' && !res.ok && res.error.code, 'forbidden', op);
  }
  const subscription = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };
  for (const op of ['push.subscribe', 'push.unsubscribe']) {
    const res = await request(socket, op, { subscription, endpoint: 'https://fcm.googleapis.com/x' });
    assert.equal(res?.t === 'res' && !res.ok && res.error.code, 'forbidden', op);
  }
  assert.deepEqual(await request(socket, 'admin.pair'), { t: 'res', id: 7, op: 'admin.pair', ok: true, result: { code: 'ABCD-EFGH', expiresAt: 5 } });
  assert.deepEqual(await request(web, 'push.subscribe', { subscription }), { t: 'res', id: 8, op: 'push.subscribe', ok: true, result: null });
  assert.deepEqual(push.subscribed, ['https://fcm.googleapis.com/x phone']);
  const http = await request(web, 'push.subscribe', { subscription: { ...subscription, endpoint: 'http://x' } });
  assert.equal(http?.t === 'res' && !http.ok && http.error.code, 'bad_request');
  const backup = await request(socket, 'admin.backup');
  assert.equal(backup?.t === 'res' && !backup.ok && backup.error.code, 'unavailable', 'no backup function given');
  const nobody = await request(socket, 'admin.revoke', { name: 'tablet' });
  assert.equal(nobody?.t === 'res' && !nobody.ok && nobody.error.code, 'not_found');
  assert.deepEqual(await request(socket, 'admin.revoke', { name: 'phone' }), { t: 'res', id: 12, op: 'admin.revoke', ok: true, result: null });
  assert.equal(web.closedWith?.code, CloseCode.unauthorized, 'the revoked device is disconnected');
  assert.equal(socket.closedWith, undefined);
});

test('requests beyond the in-flight limit are refused', async t => {
  const { hub, session, connect } = setup(t);
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  session.abort = () => gate;
  hub.start(session);
  const link = connect();
  for (let i = 1; i <= MAX_IN_FLIGHT + 1; i++) link.deliver({ t: 'req', id: i, op: 'abort', params: {} });
  await settle();
  assert.deepEqual(link.got.map(m => m.t === 'res' && !m.ok && m.error.code), ['unavailable']);
  release();
  await settle();
  assert.equal(link.got.filter(m => m.t === 'res' && m.ok).length, MAX_IN_FLIGHT);
});

test('agent feeds are opened once, shared by refcount, resynced, and ended when the agent goes', async t => {
  const { hub, session, tick, connect, request } = setup(t);
  const ada = new FakeFeed([said('a1', 'working')]);
  session.agents.set('ada', ada);
  session.set({ agents: [{ name: 'Ada', role: 'main', parent: 'Pi', busy: true }] });
  hub.start(session);
  const one = connect(), two = connect();
  const opened = await request(one, 'feed.open', { name: 'ada' });
  assert.deepEqual(opened, { t: 'res', id: 1, op: 'feed.open', ok: true, result: { feed: 'agent:ada' } });
  await request(two, 'feed.open', { name: 'ADA' });
  assert.deepEqual(session.calls.filter(call => call.startsWith('agentChat')), ['agentChat ada'], 'opened once');
  await tick(LIMITS.flushMs);
  assert.deepEqual(types(one), ['res', 'snapshot'], 'the res precedes the snapshot');
  assert.deepEqual(one.got[1], { t: 'snapshot', feed: 'agent:ada', items: ada.list });
  const nobody = await request(one, 'feed.open', { name: 'Bob' });
  assert.equal(nobody?.t === 'res' && !nobody.ok && nobody.error.code, 'not_found');

  ada.set([said('a1', 'working on it')]);
  await tick(LIMITS.flushMs);
  assert.deepEqual(last(two), { t: 'items', feed: 'agent:ada', ops: [{ op: 'append', id: 'a1', field: 'text', at: 7, text: ' on it' }] });
  await request(two, 'feed.resync', { feed: 'agent:ada' });
  await tick(LIMITS.flushMs);
  assert.equal(last(two)?.t, 'snapshot');
  const root = await request(two, 'feed.close', { feed: 'root' });
  assert.equal(root?.t === 'res' && !root.ok && root.error.code, 'bad_request');

  await request(one, 'feed.close', { feed: 'agent:ada' });
  assert.equal(ada.closed, false, 'still watched by the other');
  one.got.length = 0;
  ada.set([said('a1', 'done')]);
  await tick(LIMITS.flushMs);
  assert.equal(one.got.length, 0, 'a closed feed sends nothing');
  const again = await request(one, 'feed.close', { feed: 'agent:ada' });
  assert.equal(again?.t === 'res' && !again.ok && again.error.code, 'not_found');

  session.set({ agents: [] });
  assert.deepEqual(last(two), { t: 'feed.end', feed: 'agent:ada', reason: 'The agent is gone.' });
  assert.equal(ada.closed, true);

  // The last watcher leaving (here, by disconnecting) closes the feed.
  const bob = new FakeFeed();
  session.agents.set('bob', bob);
  session.set({ agents: [{ name: 'Bob', role: 'main', parent: 'Pi', busy: false }] });
  await request(two, 'feed.open', { name: 'Bob' });
  two.drop();
  await settle();
  assert.equal(bob.closed, true);
});

test('status goes at most every STATUS_MS, the latest one', async t => {
  const { hub, session, tick, connect } = setup(t);
  hub.start(session);
  const link = connect();
  for (let queued = 1; queued <= 20; queued++) {
    session.set({ queued });
    await tick(10);
  }
  await tick(STATUS_MS);
  const statuses = link.got.flatMap(m => m.t === 'status' ? [m.status.queued] : []);
  assert.ok(statuses.length <= 1 + Math.ceil(200 / STATUS_MS), `${statuses.length} status messages`);
  assert.equal(statuses.at(-1), 20, 'the last one is current');
});

test('a congested peer gets one coalesced diff, and is closed with 4008 when it stays over slowBytes', async t => {
  const { hub, session, tick, wait, connect } = setup(t);
  hub.start(session);
  const slow = connect(), fast = connect();
  slow.pending = LIMITS.highWater + 1;
  for (const text of ['a', 'ab', 'abc', 'abcd']) {
    session.root.set([user('e1', 'hi'), said('e2', 'Hello!'), said('live', text, true)]);
    await tick(LIMITS.flushMs);
  }
  assert.equal(slow.got.length, 0, 'nothing while over the high water mark');
  assert.equal(fast.got.length, 4);
  slow.pending = 0;
  await tick(LIMITS.flushMs);
  assert.deepEqual(slow.got, [{ t: 'items', feed: 'root', ops: [{ op: 'put', item: said('live', 'abcd', true) }] }]);

  slow.pending = LIMITS.slowBytes + 1;
  // Pings keep it from being closed as silent; only the full buffer counts.
  await wait(LIMITS.slowMs - 2_000, slow, fast);
  assert.equal(slow.closedWith?.code, undefined);
  await wait(3_000, slow, fast);
  assert.equal(slow.closedWith?.code, CloseCode.tooSlow);
  assert.equal(fast.closedWith, undefined);
});

test('a silent peer is closed after SILENCE_MS; pings keep it', async t => {
  const { hub, session, wait, connect } = setup(t);
  hub.start(session);
  const quiet = connect(), chatty = connect();
  await wait(SILENCE_MS - 1_000, chatty);
  assert.equal(quiet.closedWith?.code, undefined);
  await wait(2_000, chatty);
  assert.equal(quiet.closedWith?.code, CloseCode.normal);
  assert.equal(chatty.closedWith, undefined);
});

test('session notices reach every ready peer', t => {
  const { hub, session, connect } = setup(t);
  hub.start(session);
  const one = connect(), two = connect('web');
  session.emit('unii: compaction failed', 'warn');
  for (const link of [one, two]) assert.deepEqual(last(link), { t: 'notice', text: 'unii: compaction failed', level: 'warn' });
});

test('tools policy: confirm needed, web refused when off, every change noticed and logged', async t => {
  const { hub, session, logged, connect, request } = setup(t, { tools: { remote: 'off', idleMinutes: 30 } });
  hub.start(session);
  const web = connect('web'), socket = connect('socket');
  const refused = await request(web, 'tools.set', { enabled: true, confirm: 'enable-tools' });
  assert.equal(refused?.t === 'res' && !refused.ok && refused.error.code, 'forbidden');
  const unconfirmed = await request(socket, 'tools.set', { enabled: true });
  assert.equal(unconfirmed?.t === 'res' && !unconfirmed.ok && unconfirmed.error.code, 'bad_request');
  assert.deepEqual(session.calls, []);
  assert.deepEqual(await request(socket, 'tools.set', { enabled: true, confirm: 'enable-tools' }), { t: 'res', id: 3, op: 'tools.set', ok: true, result: null });
  assert.deepEqual(session.calls, ['tools true']);
  for (const link of [web, socket]) assert.ok(link.got.some(m => m.t === 'notice' && m.text === 'Coding tools on, by terminal.' && m.level === 'warn'));
  assert.deepEqual(await request(web, 'tools.set', { enabled: false }), { t: 'res', id: 4, op: 'tools.set', ok: true, result: null });
  assert.ok(socket.got.some(m => m.t === 'notice' && m.text === 'Coding tools off, by phone.' && m.level === 'info'));
  assert.deepEqual(logged, ['coding tools on, by socket (socket)', 'coding tools off, by me@example.com/phone (web)']);
});

test('tools turn themselves off after idleMinutes without a run', async t => {
  const { hub, session, logged, wait, connect, request } = setup(t);
  hub.start(session);
  const web = connect('web');
  await request(web, 'tools.set', { enabled: true, confirm: 'enable-tools' });
  await wait(20 * 60_000, web);
  session.set({ busy: true });
  await wait(40 * 60_000, web);
  assert.equal(session.status().toolsEnabled, true, 'a run keeps them on');
  session.set({ busy: false, agents: [{ name: 'Ada', role: 'main', parent: 'Pi', busy: true }] });
  await wait(40 * 60_000, web);
  assert.equal(session.status().toolsEnabled, true, 'so does a busy agent');
  session.set({ agents: [] });
  await wait(29 * 60_000, web);
  assert.equal(session.status().toolsEnabled, true);
  await wait(60_000, web);
  assert.equal(session.status().toolsEnabled, false);
  assert.ok(web.got.some(m => m.t === 'notice' && m.text === 'Coding tools off after 30 idle minutes.'));
  assert.ok(logged.includes('coding tools off: idle for 30 minutes'));
});

test('push: Pi finishing and agent reports notify while no one looks, once per tag per 30 s', async t => {
  const push = fakePush();
  const { hub, session, tick, connect } = setup(t, { push, pushPreview: true });
  hub.start(session);
  const run = async (answer: string): Promise<void> => {
    session.set({ busy: true });
    session.root.set([...session.root.list, said(`a${session.root.list.length}`, answer)]);
    session.set({ busy: false });
    await settle();
  };
  await run('There   are\n3 boats.');
  assert.deepEqual(push.sent, [{ title: 'Pi finished', body: 'There are 3 boats.', tag: 'pi' }]);
  await run('again');
  assert.equal(push.sent.length, 1, 'rate limited per tag');
  await tick(PUSH_EVERY_MS);
  await run('later');
  assert.equal(push.sent.length, 2);

  session.root.set([...session.root.list, { kind: 'report', id: 'r1', from: 'Ada', text: 'Found it.' }]);
  assert.deepEqual(push.sent.at(-1), { title: '[Ada]', body: 'Found it.', tag: 'agent-Ada' });

  const looking = connect('web', true);
  await tick(PUSH_EVERY_MS);
  await run('seen');
  assert.equal(push.sent.length, 3, 'a visible client suppresses it');
  looking.deliver({ t: 'visible', visible: false });
  await tick(VISIBLE_MS - 1_000);
  await run('just seen');
  assert.equal(push.sent.length, 3, 'visible within the last minute');
  await tick(1_000);
  await run('unseen');
  assert.equal(push.sent.length, 4);
  assert.equal(push.sent.at(-1)?.body, 'unseen');
});

test('push previews are off unless asked', async t => {
  const push = fakePush();
  const { hub, session } = setup(t, { push });
  hub.start(session);
  session.set({ busy: true });
  session.set({ busy: false });
  await settle();
  assert.deepEqual(push.sent, [{ title: 'Pi finished', body: '', tag: 'pi' }]);
});

test('close sends bye 1012 to every peer and refuses new ones', async t => {
  const { hub, session, connect } = setup(t);
  hub.start(session);
  const one = connect(), two = connect('web');
  await hub.close(CloseCode.restart, 'The server is stopping.');
  for (const link of [one, two]) assert.deepEqual(last(link), { t: 'bye', code: 1012, reason: 'The server is stopping.' });
  const late = fakeLink();
  hub.attach(late);
  assert.equal(late.closedWith?.code, CloseCode.restart);
});
