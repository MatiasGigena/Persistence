import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, ServerMessage, SessionStatus, Welcome } from '../../src/protocol/messages.ts';
import { Store, turnEnds } from '../../src/web/store.ts';
import type { ViewItem } from '../../src/web/store.ts';

const WELCOME: Welcome = {
  t: 'welcome', protocol: 2, server: '0.1.0', boot: 'b1', assets: 'a1', peer: 'web', cwd: '/w',
  tools: { remote: 'confirm', idleMinutes: 30 }, device: 'phone',
};
const STATUS: SessionStatus = { model: 'p/m', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [] };
const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text });
const reply = (id: string, text: string, streaming: boolean): ChatItem => ({ kind: 'assistant', id, text, streaming });

function connected(items: readonly ChatItem[] = []): Store {
  const store = new Store();
  const messages: ServerMessage[] = [WELCOME, { t: 'status', status: STATUS }, { t: 'snapshot', feed: 'root', items }, { t: 'ready' }];
  for (const msg of messages) store.handle(msg);
  return store;
}
const ids = (store: Store): string[] => store.rootView().map(item => item.id);

test('snapshot then ops build the root mirror, and every change notifies', () => {
  const store = connected([user('u1', 'hi')]);
  let calls = 0;
  store.subscribe(() => calls++);
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: reply('a1', 'He', true) }] });
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'append', id: 'a1', field: 'text', at: 2, text: 'llo' }] });
  assert.deepEqual(store.root.items.at(-1), reply('a1', 'Hello', true));
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: { kind: 'notice', id: 'n1', text: 'retry', level: 'warn' }, before: 'a1' }] });
  assert.deepEqual(ids(store), ['u1', 'n1', 'a1']);
  assert.equal(calls, 3);
});

test('an op that does not fit asks for one resync and ignores items until the snapshot', () => {
  const store = connected([user('u1', 'hi')]);
  const effects = store.handle({ t: 'items', feed: 'root', ops: [{ op: 'append', id: 'u1', field: 'text', at: 99, text: '!' }] });
  assert.deepEqual(effects, [{ t: 'resync', feed: 'root' }]);
  assert.deepEqual(store.root.items, [user('u1', 'hi')], 'the last good mirror stays');
  assert.deepEqual(store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: user('u2', 'x') }] }), []);
  assert.equal(store.root.items.length, 1);
  store.handle({ t: 'snapshot', feed: 'root', items: [user('u1', 'hi'), user('u2', 'x')] });
  assert.equal(store.root.waiting, false);
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'del', id: 'u1' }] });
  assert.deepEqual(ids(store), ['u2']);
});

test('a finished reply is announced once, but not the backlog', () => {
  const store = new Store();
  store.handle(WELCOME);
  assert.deepEqual(store.handle({ t: 'snapshot', feed: 'root', items: [reply('a0', 'old', false)] }), []);
  store.handle({ t: 'ready' });
  assert.deepEqual(store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: reply('a1', 'Hi', true) }] }), []);
  assert.deepEqual(store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: reply('a1', 'Hi there', false) }] }),
    [{ t: 'reply', text: 'Hi there', from: 'Pi' }]);
  assert.deepEqual(store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: reply('a2', 'Whole', false) }] }),
    [{ t: 'reply', text: 'Whole', from: 'Pi' }], 'a reply that arrives whole');
});

test('new assets ask for a reload; a new boot alone is a notice', () => {
  const store = connected();
  assert.deepEqual(store.handle(WELCOME), []);
  assert.deepEqual(store.handle({ ...WELCOME, boot: 'b2' }), []);
  assert.deepEqual(store.rootView().at(-1), { kind: 'notice', id: 'web:1', text: 'The server restarted.', level: 'info' });
  assert.deepEqual(store.handle({ ...WELCOME, boot: 'b3', assets: 'a2' }), [{ t: 'reload' }]);
});

test('local notices follow the item that was last, and move to the end when it leaves', () => {
  const store = connected([user('u1', 'a'), user('u2', 'b')]);
  store.notice('Model: p/x', 'info');
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: user('u3', 'c') }] });
  assert.deepEqual(ids(store), ['u1', 'u2', 'web:1', 'u3']);
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'del', id: 'u2' }] });
  assert.deepEqual(ids(store), ['u1', 'u3', 'web:1']);
  store.handle({ t: 'notice', text: 'Tools on (phone)', level: 'warn' });
  assert.deepEqual(store.rootView().find(item => item.id === 'web:2'), { kind: 'notice', id: 'web:2', text: 'Tools on (phone)', level: 'warn' });
  assert.deepEqual(ids(store), ['u1', 'u3', 'web:2', 'web:1']);
});

test('a pending send shows until its user item arrives', () => {
  const store = connected([user('u1', 'same')]);
  store.addPending('r1', 'same');
  assert.deepEqual(store.rootView().at(-1), { kind: 'pending', id: 'r1', text: 'same', state: 'sending' });
  store.handle({ t: 'items', feed: 'root', ops: [{ op: 'put', item: user('u2', 'same') }] });
  assert.equal(store.rootView().at(-1)?.kind, 'pending', 'not admitted yet: it stays');
  store.admitPending('r1');
  assert.deepEqual(ids(store), ['u1', 'u2'], 'admitted, and a new user item with its text is there');

  store.addPending('r2', 'later');
  store.admitPending('r2');
  store.handle({ t: 'status', status: { ...STATUS, busy: true, queued: 1 } });
  assert.deepEqual(store.rootView().at(-1), { kind: 'pending', id: 'r2', text: 'later', state: 'queued' });
  store.handle({ t: 'status', status: STATUS });
  assert.deepEqual(ids(store), ['u1', 'u2'], 'the run ended with nothing queued: withdrawn');

  store.addPending('r3', 'lost');
  store.dropPending('r3');
  assert.deepEqual(ids(store), ['u1', 'u2']);
});

test('agent feeds: open, sync, end, and survive a reconnect by name', () => {
  const store = connected();
  store.openAgent('f1', 'Scout');
  store.handle({ t: 'snapshot', feed: 'f1', items: [user('x', 'task')] });
  store.handle({ t: 'items', feed: 'f1', ops: [{ op: 'put', item: reply('y', 'ok', false) }] });
  assert.deepEqual(store.agentByName('Scout')?.agent.mirror.items.map(i => i.id), ['x', 'y']);
  assert.deepEqual(store.handle({ t: 'items', feed: 'nope', ops: [{ op: 'del', id: 'x' }] }), [], 'an unknown feed is ignored');

  assert.deepEqual(store.disconnect(), ['Scout']);
  assert.equal(store.agentByName('Scout')?.feed, undefined);
  assert.equal(store.agentByName('Scout')?.agent.mirror.items.length, 2, 'the last state shows while reconnecting');
  store.openAgent('f9', 'Scout');
  assert.equal(store.agentByName('Scout')?.feed, 'f9');
  assert.equal(store.agentByName('Scout')?.agent.mirror.items.length, 2);

  store.handle({ t: 'feed.end', feed: 'f9', reason: 'Scout was stopped.' });
  assert.equal(store.agentByName('Scout')?.agent.ended, 'Scout was stopped.');
  assert.deepEqual(store.disconnect(), [], 'an ended feed is not reopened');
});

test('turnEnds marks the last finished assistant text before each user message and at the end', () => {
  const items: ViewItem[] = [
    user('u1', 'hi'), reply('a1', 'one', false), reply('a2', 'two', false),
    user('u2', 'more'), reply('a3', 'three', false),
  ];
  assert.deepEqual([...turnEnds(items)], ['a2', 'a3']);
  // A streaming reply ends nothing yet; neither does one with no text.
  assert.deepEqual([...turnEnds([user('u1', 'hi'), reply('a1', 'He', true)])], []);
  assert.deepEqual([...turnEnds([user('u1', 'hi'), reply('a1', '  ', false)])], []);
  assert.deepEqual([...turnEnds([user('u1', 'hi'), reply('a1', 'done', false), reply('a2', 'Ne', true)])], []);
});

test('turnEnds keeps the end past tool, thinking, notice and empty assistant items', () => {
  const items: ViewItem[] = [
    user('u1', 'hi'), reply('a1', 'Running it', false),
    { kind: 'thinking', id: 't1', text: 'hm', streaming: false },
    { kind: 'tool', id: 'k1', name: 'bash', args: '{}', output: 'ok', status: 'done' },
    // Tool calls only, or cut off by a stop: no text, so a1 stays the end.
    reply('a2', '', false),
    { kind: 'notice', id: 'n1', text: 'Stopped', level: 'info' },
    user('u2', 'next'), reply('a3', 'answer', false), reply('a4', '', false),
  ];
  assert.deepEqual([...turnEnds(items)], ['a1', 'a3']);
});

test('turnEnds splits a turn at a pending message, a steer mid-run included', () => {
  // Deliberate: a steer is the user's message, so the answer before it ends its own stretch, as a user item would.
  const items: ViewItem[] = [
    user('u1', 'hi'), reply('a1', 'first', false),
    { kind: 'pending', id: 'p1', text: 'also this', state: 'queued' },
    reply('a2', 'second', false),
  ];
  assert.deepEqual([...turnEnds(items)], ['a1', 'a2']);
});
