import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Message, TranscriptContext } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { REPORT_KIND } from '../../src/agents/index.ts';
import { openInstance } from '../../src/runtime/runtime.ts';
import { createUiSession } from '../../src/ui/session.ts';
import type { UiSessionHandle } from '../../src/ui/session.ts';
import type { ChatFeed, ChatItem } from '../../src/ui/types.ts';
import { offlineModels } from '../fixtures/faux-model.ts';
import type { OfflineModels } from '../fixtures/faux-model.ts';

type Options = { allowTools?: boolean; slow?: boolean };

/** Like offlineModels(), but streaming slowly enough that partial answers commit (every 100 ms). */
function slowModels(responses: FauxResponseStep[]): OfflineModels {
  const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 4, max: 4 } });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const selected = faux.getModel();
  return { models, faux, model: { provider: selected.provider, modelId: selected.id } };
}

async function open(t: TestContext, responses: FauxResponseStep[], { allowTools = false, slow = false }: Options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-ui-'));
  const catalog = slow ? slowModels(responses) : offlineModels(responses);
  const instance = await openInstance({ databasePath: join(cwd, 'chat.sqlite'), cwd, allowTools, ...catalog });
  const session = await createUiSession(instance, { model: catalog.model, thinkingLevel: 'high', allowTools }, { refreshMs: 50 });
  t.after(async () => {
    await session.close();
    await instance.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { instance, session, catalog };
}

/** Resolve once `check()` holds, rechecking after each change of `feed` (and every 20 ms). */
async function until<T>(check: () => T | undefined | false, what: string, feed?: ChatFeed, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(feed?.items())}`);
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, 20);
      const off = feed?.subscribe(done);
      function done(): void { clearTimeout(timer); off?.(); resolve(); }
    });
  }
}

const idle = (session: UiSessionHandle) => until(() => !session.status().busy && session.status().queued === 0, 'idle');
type ItemOf<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;
const isKind = <K extends ChatItem['kind']>(item: ChatItem, kind: K): item is ItemOf<K> => item.kind === kind;
function find<K extends ChatItem['kind']>(feed: ChatFeed, kind: K, test: (item: ItemOf<K>) => boolean = () => true): ItemOf<K> | undefined {
  for (const item of feed.items()) if (isKind(item, kind) && test(item)) return item;
  return undefined;
}
const lastUserText = (context: TranscriptContext): string => {
  const message: Message | undefined = context.messages.findLast(each => each.role === 'user');
  if (!message) return '';
  return typeof message.content === 'string' ? message.content
    : message.content.map(block => block.type === 'text' ? block.text : '').join('\n');
};

describe('UI session over a real instance (faux model)', { concurrency: false, timeout: 30_000 }, () => {
  test('send: the user item, then the answer streams and ends with the same id', async (t) => {
    const answer = 'The lighthouse keeper rang the bell twice before dawn, then slept.';
    const { session } = await open(t, [fauxAssistantMessage([fauxThinking('the keeper'), fauxText(answer)])], { slow: true });
    const seen: { id: string; text: string; streaming: boolean }[] = [];
    // The TUI caches per item object: a shown object never changes; a changed item is a new object.
    const shown = new Map<ChatItem, string>();
    session.chat.subscribe(() => {
      for (const each of session.chat.items()) if (!shown.has(each)) shown.set(each, JSON.stringify(each));
      const item = find(session.chat, 'assistant');
      if (item) seen.push({ id: item.id, text: item.text, streaming: item.streaming });
    });

    await session.send('tell me about the keeper');
    const user = await until(() => find(session.chat, 'user'), 'the user item', session.chat);
    assert.equal(user.text, 'tell me about the keeper');
    const done = await until(() => find(session.chat, 'assistant', item => !item.streaming), 'the final answer', session.chat);
    assert.equal(done.text, answer);

    const streamed = seen.filter(each => each.streaming);
    assert.ok(streamed.length > 0, 'the answer was shown while streaming');
    assert.ok(streamed.every(each => each.id === done.id && answer.startsWith(each.text)), JSON.stringify(seen));
    assert.equal(find(session.chat, 'thinking')?.text, 'the keeper');
    assert.equal(find(session.chat, 'user'), user, 'an unchanged item keeps its object');
    for (const [item, json] of shown) assert.equal(JSON.stringify(item), json, 'items are never mutated');
    assert.ok(new Set([...shown.keys()].filter(item => item.kind === 'assistant')).size > 1, 'each change is a new object');
    assert.deepEqual(session.chat.items().map(item => item.kind), ['user', 'thinking', 'assistant']);
  });

  test('a zoom tool round ends as a done tool item; tools on and off show in the status', async (t) => {
    const { session } = await open(t, [
      fauxAssistantMessage('noted'),
      fauxAssistantMessage(fauxToolCall('zoom', { id: 0, n: 1 }, { id: 'call-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('it was the lighthouse'),
    ]);
    assert.equal(session.status().toolsEnabled, false);
    assert.match(session.status().model, /^faux\//);
    assert.equal(session.status().thinkingLevel, 'high');
    await session.send('remember the lighthouse');
    await until(() => find(session.chat, 'assistant', item => item.text === 'noted'), 'the first answer', session.chat);
    await idle(session);
    await session.send('what did I say?');
    const tool = await until(() => find(session.chat, 'tool', item => item.status === 'done'), 'the tool result', session.chat);
    assert.deepEqual({ ...tool, output: '' }, { kind: 'tool', id: 'tool:call-1', name: 'zoom', args: '{"id":0,"n":1}', output: '', status: 'done' });
    assert.equal(tool.output, '0+1|user: remember the lighthouse');
    await until(() => find(session.chat, 'assistant', item => item.text === 'it was the lighthouse'), 'the last answer', session.chat);
    assert.deepEqual(session.chat.items().map(item => item.kind), ['user', 'assistant', 'user', 'tool', 'assistant']);

    const { session: tools } = await open(t, [], { allowTools: true });
    assert.equal(tools.status().toolsEnabled, true);
  });

  test('an agents.report input is a report item from its agent', async (t) => {
    const { instance, session } = await open(t, [fauxAssistantMessage('thanks, Bob')]);
    await instance.root.submit({ type: 'input', content: '[Bob] built it',
      entry: { kind: REPORT_KIND, data: { name: 'Bob', text: 'built it', id: 'r1' } } }, instance.context);
    const report = await until(() => find(session.chat, 'report'), 'the report', session.chat);
    assert.equal(report.from, 'Bob');
    assert.equal(report.text, 'built it');
    await until(() => find(session.chat, 'assistant', item => item.text === 'thanks, Bob'), 'the answer', session.chat);
    assert.equal(find(session.chat, 'user'), undefined, 'a report is not shown as the user');
  });

  test('a spawned agent: its feed by name, its report back in Pi\'s feed, and the agents status', async (t) => {
    // One responder for every conversation and turn, by what it was last told.
    const respond = (context: TranscriptContext) => {
      const last = context.messages.at(-1);
      const said = lastUserText(context);
      if (last?.role === 'toolResult') return fauxAssistantMessage('Bob is on it.');
      if (said.includes('[from Pi] count the boats')) return fauxAssistantMessage('There are 3 boats.');
      if (said.includes('[Bob] There are 3 boats.')) return fauxAssistantMessage('Bob counted 3 boats.');
      return fauxAssistantMessage(fauxToolCall('spawn_agent', { name: 'Bob', task: 'count the boats' }, { id: 'spawn-1' }), { stopReason: 'toolUse' });
    };
    const { session } = await open(t, Array.from({ length: 8 }, () => respond));
    await session.send('get someone to count the boats');
    const report = await until(() => find(session.chat, 'report'), 'Bob\'s report', session.chat);
    assert.deepEqual([report.from, report.text], ['Bob', 'There are 3 boats.']);
    await until(() => find(session.chat, 'assistant', item => item.text === 'Bob counted 3 boats.'), 'Pi\'s answer', session.chat);
    const agents = await until(() => session.status().agents.length === 1 && session.status().agents, 'the agents status');
    assert.deepEqual(agents.map(agent => [agent.name, agent.role, agent.parent]), [['Bob', 'main', 'Pi']]);

    const bob = await session.agentChat('bob');
    assert.ok(bob);
    await until(() => find(bob, 'assistant', item => item.text === 'There are 3 boats.'), 'Bob\'s answer', bob);
    assert.deepEqual(find(bob, 'report'), { kind: 'report', id: find(bob, 'report')?.id, from: 'Pi', text: 'count the boats' });
    await bob.close();
    assert.equal(await session.agentChat('nobody'), undefined);
  });

  test('busy and queued follow the run and the inbox; listeners fire on changes', async (t) => {
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { session } = await open(t, [async () => { await gate; return fauxAssistantMessage('first'); }, fauxAssistantMessage('second')]);
    let fired = 0;
    session.onStatus(() => { fired++; });
    assert.deepEqual([session.status().busy, session.status().queued], [false, 0]);

    await session.send('one');
    await until(() => session.status().busy, 'busy');
    await session.send('two');
    await until(() => session.status().queued === 1, 'one queued');
    release();
    await idle(session);
    await until(() => find(session.chat, 'assistant', item => item.text === 'second'), 'the second answer', session.chat);
    assert.ok(fired >= 3, `fired ${fired}`);
    const count = fired;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fired, count, 'polling alone fires nothing when nothing changed');
  });

  test('the memory view after a few turns, and zoom', async (t) => {
    const { session } = await open(t, [fauxAssistantMessage('A1'), fauxAssistantMessage('A2')]);
    assert.deepEqual(session.memoryView(), []);
    for (const text of ['first', 'second']) {
      await session.send(text);
      await idle(session);
    }
    const lines = await until(() => session.memoryView().length === 4 && session.memoryView(), 'four view lines');
    assert.deepEqual(lines, [
      { id: 0, n: 1, text: 'user: first' }, { id: 1, n: 1, text: 'pi: A1' },
      { id: 2, n: 1, text: 'user: second' }, { id: 3, n: 1, text: 'pi: A2' },
    ]);
    assert.equal(session.zoom(2, 1), '2+1|user: second');
    assert.throws(() => session.zoom(9, 1), /No line 9\+1/);
    await until(() => session.status().memory?.messages === 4, 'the memory status');
  });

  test('abort interrupts the streaming answer; it stays shown, no longer streaming', async (t) => {
    const long = `${'The tide comes in and the tide goes out. '.repeat(20)}End.`;
    const { session } = await open(t, [fauxAssistantMessage(long), fauxAssistantMessage('after')], { slow: true });
    await session.send('tell me a long story');
    await until(() => find(session.chat, 'assistant', item => item.streaming), 'a streaming answer', session.chat);
    await session.abort();
    assert.equal(session.status().busy, false);
    const notice = await until(() => find(session.chat, 'notice'), 'the notice', session.chat);
    assert.deepEqual([notice.text, notice.level], ['Interrupted.', 'info']);
    const cut = find(session.chat, 'assistant');
    assert.ok(cut && !cut.streaming && long.startsWith(cut.text) && cut.text.length < long.length, JSON.stringify(cut));

    await session.send('go on');
    await until(() => find(session.chat, 'assistant', item => item.text === 'after' && !item.streaming), 'the next answer', session.chat);
  });

  test('a second session rebuilds the same history from the snapshot', async (t) => {
    const { instance, session, catalog } = await open(t, [
      fauxAssistantMessage(fauxToolCall('date', { id: 0 }, { id: 'call-d' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('it is today'),
    ]);
    await session.send('what day is it?');
    await until(() => find(session.chat, 'assistant', item => item.text === 'it is today'), 'the answer', session.chat);
    const again = await createUiSession(instance, { model: catalog.model, thinkingLevel: 'high', allowTools: false });
    t.after(() => again.close());
    assert.deepEqual(again.chat.items(), session.chat.items(), 'answers that did not stream keep their entry ids');
    assert.equal(find(again.chat, 'tool')?.status, 'done');
  });
});

