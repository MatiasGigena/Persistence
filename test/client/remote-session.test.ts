import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RemoteSession } from '../../src/client/remote-session.ts';
import { RequestError } from '../../src/protocol/request-error.ts';
import type { RemoteSessionOptions } from '../../src/client/remote-session.ts';
import { ClientLink } from '../../src/client/unix-link.ts';
import { CloseCode, ROOT_FEED } from '../../src/protocol/messages.ts';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { Hub } from '../../src/server/hub.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';
import type { ChatItem, NoticeLevel } from '../../src/protocol/session.ts';
import { FakeServer } from '../fixtures/fake-server.ts';
import { fakeLink, fakeSession } from '../fixtures/server-fakes.ts';
import type { FakeServerOptions } from '../fixtures/fake-server.ts';
import { memoryConnector } from './memory-link.ts';
import type { MemoryConnector } from './memory-link.ts';

const ITEMS: readonly ChatItem[] = [
  { kind: 'user', id: 'e1', text: 'hi' },
  { kind: 'assistant', id: 'e2', text: 'Hello', streaming: false },
];

/** Waits until `ok()` holds, or fails after `ms`. */
async function until(ok: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(2);
  }
}

interface Attached {
  readonly server: FakeServer;
  readonly wire: MemoryConnector;
  readonly link: ClientLink;
  readonly session: RemoteSession;
  readonly notices: [string, NoticeLevel][];
  /** The client messages of one op, parsed. */
  readonly requests: (op: string) => Record<string, unknown>[];
}

async function attach(options: FakeServerOptions = {}, sessionOptions: RemoteSessionOptions = {}): Promise<Attached> {
  const server = new FakeServer({ items: ITEMS, ...options });
  const wire = memoryConnector(server);
  const link = new ClientLink({ connect: wire.connect, client: 'test', helloMs: 300, retry: { first: 5, max: 20 } });
  const session = new RemoteSession(link, sessionOptions);
  const notices: [string, NoticeLevel][] = [];
  session.onNotice((text, level) => notices.push([text, level]));
  await link.start();
  await session.ready();
  const requests = (op: string): Record<string, unknown>[] => wire.sent.flatMap(text => {
    const message: unknown = JSON.parse(text);
    return typeof message === 'object' && message !== null && 'op' in message && message.op === op && 'params' in message
      && typeof message.params === 'object' && message.params !== null ? [{ ...message.params }] : [];
  });
  return { server, wire, link, session, notices, requests };
}

const lastPeer = (wire: MemoryConnector) => wire.peers.at(-1) ?? assert.fail('no peer');

test('the first snapshot fills the chat, then ops keep it equal to the server', async () => {
  const { server, session } = await attach();
  assert.deepEqual(session.chat.items(), ITEMS);
  assert.equal(session.welcome()?.cwd, '/fake/cwd');
  assert.equal(session.attached.state(), 'ready');
  let changes = 0;
  session.chat.subscribe(() => changes++);
  server.setItems([...ITEMS, { kind: 'assistant', id: 'live.0', text: 'Th', streaming: true }]);
  server.setItems([ITEMS[0] ?? assert.fail(), { kind: 'notice', id: 'n1', text: 'retry', level: 'warn' }, ITEMS[1] ?? assert.fail(),
    { kind: 'assistant', id: 'live.0', text: 'There are 3.', streaming: true }]);
  await until(() => session.chat.items().length === 4, 'the ops');
  assert.deepEqual(session.chat.items(), server.rootItems());
  assert.ok(changes >= 2);
  await session.close();
  assert.equal(session.attached.state(), 'closed');
});

test('an append that does not fit asks for a resync, ignores items until the snapshot, then matches', async () => {
  const { server, wire, session, requests } = await attach();
  server.hold('feed.resync');
  lastPeer(wire).push({ t: 'items', feed: ROOT_FEED, ops: [{ op: 'append', id: 'e2', field: 'text', at: 99, text: '!' }] });
  await until(() => requests('feed.resync').length === 1, 'feed.resync');
  assert.deepEqual(requests('feed.resync')[0], { feed: ROOT_FEED });
  assert.deepEqual(session.chat.items(), ITEMS, 'the last good mirror stays');
  lastPeer(wire).push({ t: 'items', feed: ROOT_FEED, ops: [{ op: 'del', id: 'e1' }] });
  await delay(20);
  assert.deepEqual(session.chat.items(), ITEMS, 'items wait for the snapshot');
  server.setItems([...ITEMS, { kind: 'user', id: 'e3', text: 'more' }]);
  server.release('feed.resync');
  await until(() => session.chat.items().length === 3, 'the snapshot');
  assert.deepEqual(session.chat.items(), server.rootItems());
  server.setItems([...server.rootItems(), { kind: 'user', id: 'e4', text: 'after' }]);
  await until(() => session.chat.items().length === 4, 'ops after the snapshot');
  await session.close();
});

test('status and notices flow; tools on carries the confirmation, off does not', async () => {
  const { server, session, notices, requests } = await attach();
  assert.deepEqual(session.status(), server.status);
  let statuses = 0;
  session.onStatus(() => statuses++);
  server.setStatus({ busy: true, queued: 1 });
  await until(() => session.status().busy, 'the status');
  assert.equal(statuses, 1);
  server.notice('Memory: compaction failed', 'warn');
  await until(() => notices.length === 1, 'the notice');
  assert.deepEqual(notices[0], ['Memory: compaction failed', 'warn']);
  await session.setTools(true);
  await until(() => session.status().toolsEnabled, 'tools on');
  assert.deepEqual(notices.at(-1), ['Coding tools on (terminal)', 'warn']);
  await session.setTools(false);
  assert.deepEqual(requests('tools.set'), [{ enabled: true, confirm: 'enable-tools' }, { enabled: false }]);
  session.notify('local', 'error');
  assert.deepEqual(notices.at(-1), ['local', 'error']);
  await session.close();
});

test('requests map to ops, and failures reject with the server\'s readable message', async () => {
  const { server, session } = await attach({ agents: { Bob: [] } }, { requestTimeoutMs: 100 });
  assert.deepEqual(await session.memoryView(), [{ id: 0, n: 1, text: 'hello' }, { id: 1, n: 1, text: 'world' }]);
  assert.equal(await session.zoom(1, 1), 'zoomed world');
  await assert.rejects(session.zoom(9, 9), (error: unknown) => error instanceof RequestError && error.code === 'not_found'
    && /No line 9\+9/.test(error.message));
  assert.equal((await session.models()).length, 3);
  await session.setModel('faux', 'model-2');
  await until(() => session.status().model === 'faux/model-2', 'the model');
  await assert.rejects(session.setModel('locked', 'model-3'), /has no credentials/);
  await assert.rejects(session.send('   '), { code: 'bad_request' });
  assert.equal(await session.agentChat('nobody'), undefined);
  await session.abort();
  assert.equal(server.aborts, 1);
  assert.deepEqual(await session.stopAgents('bob'), ['Bob']);
  server.hold('models');
  await assert.rejects(session.models(), { code: 'timeout', message: /did not answer models/ });
  await session.close();
  await assert.rejects(session.models(), { code: 'disconnected' });
});

test('an agent feed opens with its snapshot, follows ops, ends, and closes on the server', async () => {
  const { server, session, requests } = await attach({ agents: { Bob: [{ kind: 'user', id: 'b1', text: 'count' }] } });
  const feed = await session.agentChat('bob') ?? assert.fail('no feed');
  await until(() => feed.items().length === 1, 'the agent snapshot');
  server.setAgentItems('Bob', [{ kind: 'user', id: 'b1', text: 'count' }, { kind: 'assistant', id: 'b2', text: '3', streaming: false }]);
  await until(() => feed.items().length === 2, 'the agent ops');
  const again = await session.agentChat('Bob') ?? assert.fail('no second handle');
  assert.equal(requests('feed.open').length, 1, 'a second handle shares the mirror');
  await again.close();
  assert.equal(requests('feed.close').length, 0, 'still open while a handle is');
  await feed.close();
  await until(() => requests('feed.close').length === 1, 'feed.close');
  const other = await session.agentChat('Bob') ?? assert.fail('no reopened feed');
  await until(() => other.items().length === 2, 'the reopened snapshot');
  server.removeAgent('Bob');
  await delay(20);
  assert.equal(other.items().length, 2, 'an ended feed keeps its last items');
  await other.close();
  assert.equal(requests('feed.close').length, 1, 'an ended feed is not closed again');
  await session.close();
});

test('a reconnect gets a fresh snapshot, re-opens agent feeds under their new ids, and says the server restarted', async () => {
  const { server, wire, session, notices } = await attach({ agents: { Bob: [{ kind: 'user', id: 'b1', text: 'x' }] } });
  const feed = await session.agentChat('Bob') ?? assert.fail('no feed');
  await until(() => feed.items().length === 1, 'the agent snapshot');
  const states: string[] = [];
  session.attached.onChange(() => states.push(session.attached.state()));
  server.restart();
  server.setItems([...ITEMS, { kind: 'user', id: 'e3', text: 'while away' }]);
  await until(() => wire.peers.length === 2 && session.attached.state() === 'ready', 'the reconnect');
  assert.deepEqual(states.slice(0, 1), ['reconnecting']);
  assert.equal(states.at(-1), 'ready');
  assert.deepEqual(session.chat.items(), server.rootItems(), 'a fresh snapshot');
  assert.deepEqual(notices.at(-1), ['The server restarted.', 'info']);
  // The server's record, not the client's: `requests` counts what the client sent, and the peer handles it a
  // setImmediate later, so reading the peer's feeds then could still find root alone.
  await until(() => server.requests.filter(request => request.op === 'feed.open').length === 2, 'the agent feed re-opened');
  const ids = [...lastPeer(wire).feeds.keys()];
  assert.equal(ids.length, 2, 'root and Bob');
  server.setAgentItems('Bob', [{ kind: 'user', id: 'b1', text: 'x' }, { kind: 'user', id: 'b2', text: 'y' }]);
  await until(() => feed.items().length === 2, 'agent ops under the new id');
  await session.close();
});

test('requests pending when the link drops reject readably; sends made while it is down go once it is back', async () => {
  const { server, wire, session } = await attach();
  server.hold('memory.view');
  const view = session.memoryView();
  await until(() => server.queue.length === 1, 'the held request');
  wire.down = true;
  lastPeer(wire).drop();
  await assert.rejects(view, { code: 'disconnected', message: 'Connection to the server lost' });
  await until(() => session.attached.state() === 'reconnecting', 'reconnecting');
  await assert.rejects(session.models(), /reconnecting/);
  const later = session.send('while down');
  await delay(30);
  wire.down = false;
  await later;
  assert.deepEqual(server.sends.map(sent => sent.text), ['while down']);
  await session.close();
});

test('a send whose answer a drop lost is resent with its requestId and admitted once', async () => {
  const { server, wire, session, requests } = await attach();
  server.hold('send');
  const sent = session.send('count the boats');
  await until(() => server.sends.length === 1, 'the admission');
  lastPeer(wire).drop();
  server.release('send');
  await sent;
  const ids = requests('send').map(params => params.requestId);
  assert.equal(ids.length, 2, 'sent twice');
  assert.equal(ids[0], ids[1], 'with one requestId');
  assert.equal(server.sends.length, 1, 'admitted once');
  assert.deepEqual(server.rootItems().filter(item => item.kind === 'user' && item.text === 'count the boats').length, 1);
  await session.send('next');
  const all = requests('send').map(params => params.requestId);
  assert.notEqual(all[2], all[0], 'each message has its own id');
  await session.close();
});

test('a steering send carries steer: true; a plain one has no steer key', async () => {
  const { server, session, requests } = await attach();
  await session.send('count the boats', { requestId: 'r-1' });
  await session.send('only the red ones', { requestId: 'r-2', steer: true });
  await session.send('thanks');
  const sent = requests('send');
  assert.deepEqual(sent.slice(0, 2), [{ text: 'count the boats', requestId: 'r-1' }, { text: 'only the red ones', requestId: 'r-2', steer: true }]);
  assert.equal(sent.length, 3);
  assert.equal('steer' in (sent[2] ?? assert.fail('no third send')), false);
  assert.equal(typeof sent[2]?.requestId, 'string', 'a generated requestId still goes with it');
  assert.deepEqual(server.sends.map(each => each.text), ['count the boats', 'only the red ones', 'thanks']);
  await session.close();
});

test('bye 4000 closes for good with a notice; pending requests reject', async () => {
  const { server, wire, session, notices } = await attach();
  server.hold('models');
  const models = session.models();
  await until(() => server.queue.length === 1, 'the held request');
  lastPeer(wire).close(CloseCode.version, `protocol ${PROTOCOL + 1} only`);
  await assert.rejects(models, { code: 'disconnected' });
  await until(() => session.attached.state() === 'closed', 'closed');
  assert.ok((notices.at(-1)?.[0] ?? '').includes(
    `refused this client's protocol (${PROTOCOL}): protocol ${PROTOCOL + 1} only. Update pi-durable`));
  await delay(30);
  assert.equal(wire.peers.length, 1, 'no reconnect');
  await assert.rejects(session.send('x'), { code: 'disconnected' });
  await session.close();
});

test('archive and restore go to the real hub as agents.archive and agents.restore, and its refusals come back', async () => {
  const hub = new Hub({ server: '0.1.0', boot: 'b', assets: 'a', cwd: '/w', tools: { remote: 'confirm' }, pushPreview: false, log: () => {} });
  const state = fakeSession();
  state.set({ agents: [{ name: 'Coder', role: 'main', parent: 'Pi', busy: false }, { name: 'Bob', role: 'main', parent: 'Pi', busy: true },
    { name: 'Kid', role: 'sub', parent: 'Bob', busy: false }] });
  hub.start(state);
  // A ServerLink straight onto the hub's PeerLink: what the client sends is delivered, what the hub sends is heard.
  const peer = fakeLink('socket'), heard = new Set<(message: ServerMessage) => void>();
  const sent: string[] = [];
  const realSend = peer.send.bind(peer);
  peer.send = text => { realSend(text); const message = peer.got.at(-1); if (message) for (const listener of heard) listener(message); };
  const session = new RemoteSession({
    state: () => 'ready', closedBecause: () => undefined, onChange: () => () => {},
    onMessage: listener => { heard.add(listener); return () => heard.delete(listener); },
    send: message => { sent.push(message.t === 'req' ? message.op : message.t); peer.deliver(message); return true; },
    close: () => {},
  });
  const notices: string[] = [];
  session.onNotice(text => notices.push(text));
  hub.attach(peer);
  peer.hello();
  await session.ready();
  assert.deepEqual(await session.archiveAgents({ name: 'bob' }), ['Bob']);
  await until(() => session.status().agents.some(agent => agent.name === 'Bob' && agent.archivedAt !== undefined), 'Bob archived in the status');
  assert.deepEqual(notices, ['Archived Bob, by terminal.']);
  await assert.rejects(session.archiveAgents({ name: 'Coder' }), { code: 'failed', message: /standing agent/ });
  await assert.rejects(session.restoreAgent('Nobody'), { code: 'not_found', message: 'No agent named Nobody.' });
  assert.deepEqual(await session.restoreAgent('Bob'), ['Bob']);
  assert.deepEqual(await session.archiveAgents({ adhoc: true }), ['Bob']);
  assert.deepEqual(sent, ['agents.archive', 'agents.archive', 'agents.restore', 'agents.restore', 'agents.archive']);
  assert.deepEqual(state.calls, ['archive bob', 'archive Coder', 'restore Nobody', 'restore Bob', 'archive adhoc']);
  // Schedules come with the status, and a cancel goes as schedule.cancel.
  state.set({ schedules: [{ id: 3, text: 'Check the deploy.', at: 2_000_000 }] });
  await until(() => session.status().schedules?.length === 1, 'the schedule in the status');
  await session.cancelSchedule(3);
  await until(() => session.status().schedules?.length === 0, 'the schedule gone from the status');
  await assert.rejects(session.cancelSchedule(3), { code: 'not_found', message: 'No schedule #3.' });
  assert.deepEqual(sent.slice(-2), ['schedule.cancel', 'schedule.cancel']);
  await session.close();
  await hub.close(CloseCode.restart, 'done');
});
