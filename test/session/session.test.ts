import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Message, Model, TranscriptContext } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import type { Agent } from '@earendil-works/pi-durable';
import { listAgents, REPORT_KIND } from '../../src/agents/index.ts';
import { parseArgs, resolveOptions } from '../../src/config/options.ts';
import { openInstance } from '../../src/runtime/runtime.ts';
import type { Instance } from '../../src/runtime/runtime.ts';
import { createUiSession } from '../../src/session/session.ts';
import type { UiSessionHandle } from '../../src/session/session.ts';
import type { ChatFeed, ChatItem } from '../../src/protocol/session.ts';
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
  const instance = await openInstance({ protection: 'unguarded', databasePath: join(cwd, 'chat.sqlite'), cwd, allowTools, ...catalog });
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

  test('images go to the model with the text and show on the user item; a model without images refuses', async (t) => {
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' };
    let seen: TranscriptContext | undefined;
    const { session } = await open(t, [(context) => { seen = context; return fauxAssistantMessage('a screenshot'); }]);
    await session.send('what is this?', { images: [image] });
    const user = await until(() => find(session.chat, 'user'), 'the user item', session.chat);
    assert.deepEqual(user, { kind: 'user', id: user.id, text: 'what is this?', images: [image] });
    await until(() => find(session.chat, 'assistant', item => item.text === 'a screenshot'), 'the answer', session.chat);
    const last = seen?.messages.findLast(each => each.role === 'user');
    assert.ok(last && typeof last.content !== 'string');
    assert.deepEqual(last.content.filter(block => block.type === 'image'), [{ type: 'image', ...image }]);
    assert.match(lastUserText(seen ?? { messages: [] } as unknown as TranscriptContext), /what is this\?/);

    const blind = fauxProvider({ models: [{ id: 'blind', input: ['text'] }] });
    const models = createModels();
    models.setProvider(blind.provider);
    const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-ui-'));
    const model = { provider: blind.getModel().provider, modelId: 'blind' };
    const instance = await openInstance({ protection: 'unguarded', databasePath: join(cwd, 'chat.sqlite'), cwd, allowTools: false, models, model });
    const other = await createUiSession(instance, { model, thinkingLevel: 'high', allowTools: false }, { refreshMs: 50 });
    t.after(async () => { await other.close(); await instance.close(); await rm(cwd, { recursive: true, force: true }); });
    await assert.rejects(other.send('look', { images: [image] }), /does not take images; nothing was sent/);
    assert.equal(find(other.chat, 'user'), undefined, 'nothing was admitted');
  });

  test('an answer with nothing to show ends with a notice, not in silence', async (t) => {
    const { session } = await open(t, [fauxAssistantMessage([fauxThinking('nothing to add')])]);
    await session.send('anything?');
    const notice = await until(() => find(session.chat, 'notice'), 'the notice', session.chat);
    assert.equal(notice.text, 'The model ended its turn without a reply.');
    assert.equal(notice.level, 'warn');
    assert.deepEqual(session.chat.items().map(item => item.kind), ['user', 'thinking', 'notice']);
  });

  test('a message its model cannot answer says why, not the SDK\'s reason code', async (t) => {
    const { session, catalog } = await open(t, []);
    catalog.models.deleteProvider(catalog.model.provider);
    await session.send('anyone there?');
    const notice = await until(() => find(session.chat, 'notice'), 'the notice', session.chat);
    assert.deepEqual([notice.text, notice.level], ['Not answered: the model is not available; pick another model.', 'warn']);
  });

  test('a run that faults says so once, without the task kind or the SDK\'s reason code', async (t) => {
    // A non-finite number is not strict JSON: the run's task faults.
    const { session } = await open(t, [fauxAssistantMessage([fauxToolCall('date', { x: Number.NaN })])]);
    await session.send('what day is it?');
    await until(() => !session.status().busy && find(session.chat, 'notice'), 'the notice', session.chat);
    await idle(session);
    const notices = session.chat.items().flatMap(item => item.kind === 'notice' ? [[item.text, item.level]] : []);
    assert.deepEqual(notices, [['The reply failed: Value contains a non-finite number and is not strict JSON', 'error']]);
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
      if (said.includes('[Bob]\nThere are 3 boats.')) return fauxAssistantMessage('Bob counted 3 boats.');
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

  test('a steering send joins the running work after its tool round, not as a follow-up run', async (t) => {
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const asked: string[] = [];
    const { session } = await open(t, [
      async () => { await gate; return fauxAssistantMessage(fauxToolCall('date', { id: 0 }, { id: 'call-d' }), { stopReason: 'toolUse' }); },
      context => { asked.push(lastUserText(context)); return fauxAssistantMessage('noted, in UTC'); },
    ]);
    await session.send('what day is it?');
    await until(() => session.status().busy, 'busy');
    await session.send('in UTC, please', { requestId: 'steer-1', steer: true });
    release();
    await idle(session);
    await until(() => find(session.chat, 'assistant', item => item.text === 'noted, in UTC'), 'the answer', session.chat);
    assert.equal(asked.length, 1, 'one more step, no follow-up run');
    assert.match(asked[0] ?? '', /date: .*\n[^]*new message:\n\nin UTC, please$/, 'the step after the date round saw the steer last');
    assert.deepEqual(session.chat.items().map(item => item.kind), ['user', 'tool', 'user', 'assistant']);
  });

  test('the memory view after a few turns, and zoom', async (t) => {
    const { session } = await open(t, [fauxAssistantMessage('A1'), fauxAssistantMessage('A2')]);
    assert.deepEqual(await session.memoryView(), []);
    for (const text of ['first', 'second']) {
      await session.send(text);
      await idle(session);
    }
    await until(() => session.status().memory?.viewLines === 4, 'four view lines');
    assert.deepEqual(await session.memoryView(), [
      { id: 0, n: 1, text: 'user: first' }, { id: 1, n: 1, text: 'pi: A1' },
      { id: 2, n: 1, text: 'user: second' }, { id: 3, n: 1, text: 'pi: A2' },
    ]);
    assert.equal(await session.zoom(2, 1), '2+1|user: second');
    await assert.rejects(session.zoom(9, 1), /No line 9\+1/);
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


const CODING = ['bash', 'edit', 'read', 'write'];
const coding = (agent: Agent | undefined): string[] => (agent?.tools ?? []).map(tool => tool.name).filter(name => CODING.includes(name)).sort();

/**
 * Pi on faux/one, beside a faux/two, a claude-cli stand-in (sonnet, haiku) and an anthropic one without credentials.
 * `seen` is every request's provider/model, in order. Pi spawns Bob when asked to, and a claude-cli/haiku request is a
 * compaction.
 */
async function openRoutes(t: TestContext, { inspect = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-switch-'));
  const seen: string[] = [], efforts: (string | undefined)[] = [];
  const respond = (context: TranscriptContext, options: { reasoning?: string } | undefined, _state: unknown, model: Model<string>) => {
    seen.push(`${model.provider}/${model.id}`);
    efforts.push(options?.reasoning);
    if (model.id === 'haiku') return fauxAssistantMessage('a short summary');
    const said = lastUserText(context);
    if (context.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('Bob is on it.');
    if (said.includes('[from Pi] count the boats')) return fauxAssistantMessage('There are 3 boats.');
    if (said.includes('[Bob]\nThere are 3 boats.')) return fauxAssistantMessage('Bob counted 3 boats.');
    if (said.includes('spawn Bob')) {
      return fauxAssistantMessage(fauxToolCall('spawn_agent', { name: 'Bob', task: 'count the boats' }, { id: 'spawn-1' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const pi = fauxProvider({ models: [{ id: 'one' }, { id: 'two', reasoning: true }] });
  const cli = fauxProvider({ api: 'faux-cli', provider: 'claude-cli', models: [{ id: 'sonnet', name: 'Claude Sonnet (CLI)' }, { id: 'haiku' }] });
  const api = fauxProvider({ api: 'faux-anthropic', provider: 'anthropic', models: [{ id: 'claude-sonnet-5-5' }] });
  for (const handle of [pi, cli]) handle.setResponses(Array.from({ length: 40 }, () => respond));
  const models = createModels();
  models.setProvider(pi.provider);
  models.setProvider(cli.provider);
  models.setProvider({ ...api.provider, auth: { apiKey: { name: 'Anthropic API key', resolve: async () => undefined } } });
  const model = { provider: 'faux', modelId: 'one' };
  const databasePath = join(cwd, 'chat.sqlite'), settingsPath = join(cwd, 'settings.json');
  const instance = await openInstance({ protection: 'unguarded', databasePath, cwd, models, model, configureAgent: !inspect });
  const session = await createUiSession(instance, { model, thinkingLevel: 'high', allowTools: false, settingsPath }, { refreshMs: 50 });
  t.after(async () => {
    await session.close();
    await instance.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { instance, session, seen, efforts, cwd, databasePath, settingsPath };
}

const answers = (session: UiSessionHandle) => session.chat.items().filter(item => item.kind === 'assistant' && !item.streaming).length;

/** Ask Pi to spawn Bob; resolves with Bob's conversation once Pi has answered his report. */
async function spawnBob(instance: Instance, session: UiSessionHandle) {
  await session.send('spawn Bob');
  await until(() => find(session.chat, 'assistant', item => item.text === 'Bob counted 3 boats.'), 'Pi\'s answer to Bob', session.chat);
  await until(() => session.status().agents.length === 1, 'Bob in the status');
  assert.deepEqual(Object.keys(session.status().agents[0] ?? {}).sort(), ['busy', 'name', 'parent', 'role'], 'no conversation IDs');
  const [bob] = await listAgents(instance.harness, instance.context);
  assert.ok(bob);
  const conversation = await instance.harness.conversation(bob.conversationId, instance.context);
  assert.ok(conversation);
  return conversation;
}

describe('switching the model and the tools', { concurrency: false, timeout: 30_000 }, () => {
  test('models() lists Pi\'s model first and marks a provider without credentials', async (t) => {
    const { session } = await open(t, []);
    const { session: routes } = await openRoutes(t);
    assert.deepEqual((await session.models())[0], { provider: 'faux', id: 'faux-1', name: 'Faux Model', available: true });
    const list = await routes.models();
    assert.deepEqual(list.map(option => [`${option.provider}/${option.id}`, option.available, option.note]), [
      ['faux/one', true, undefined], ['faux/two', true, undefined],
      ['claude-cli/sonnet', true, 'uses your Claude plan via the claude CLI'], ['claude-cli/haiku', true, 'uses your Claude plan via the claude CLI'],
      ['anthropic/claude-sonnet-5-5', false, 'needs ANTHROPIC_API_KEY'],
    ]);
  });

  test('setModel: the next request uses it, the status shows it at once, and later launches default to it', async (t) => {
    const { session, seen, cwd, databasePath, settingsPath } = await openRoutes(t);
    await session.send('first');
    await until(() => answers(session) === 1, 'the first answer', session.chat);
    assert.deepEqual(seen, ['faux/one']);

    let fired = 0;
    session.onStatus(() => { fired++; });
    await session.setModel('faux', 'two');
    assert.equal(session.status().model, 'faux/two');
    assert.ok(fired > 0, 'onStatus fired');
    await session.send('second');
    await until(() => answers(session) === 2, 'the second answer', session.chat);
    assert.deepEqual(seen, ['faux/one', 'faux/two']);

    const saved: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(saved, { model: 'faux/two' });
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    const launch = (args: string[], env: NodeJS.ProcessEnv = {}) => resolveOptions(parseArgs(['--database', databasePath, '--cwd', cwd, ...args]), env);
    const next = await launch([]);
    assert.deepEqual([next.model, next.modelSource, next.settingsPath], [{ provider: 'faux', modelId: 'two' }, 'settings', settingsPath]);
    const env = await launch([], { PI_DURABLE_MODEL: 'claude-cli/haiku' });
    assert.deepEqual([env.model, env.modelSource], [{ provider: 'claude-cli', modelId: 'haiku' }, 'env']);
    const flag = await launch(['--model', 'faux/one'], { PI_DURABLE_MODEL: 'claude-cli/haiku' });
    assert.deepEqual([flag.model, flag.modelSource], [{ provider: 'faux', modelId: 'one' }, 'flag']);
  });

  test('setModel rejects unknown and unavailable models and changes nothing', async (t) => {
    const { session, settingsPath } = await openRoutes(t);
    await assert.rejects(session.setModel('faux', 'nope'), /Unknown model faux\/nope/);
    await assert.rejects(session.setModel('anthropic', 'claude-sonnet-5-5'), /No credentials for anthropic\./);
    assert.equal(session.status().model, 'faux/one');
    await assert.rejects(stat(settingsPath), { code: 'ENOENT' });
  });

  test('an agent and the compactor follow a switch to claude-cli', async (t) => {
    const { instance, session, seen } = await openRoutes(t);
    const bob = await spawnBob(instance, session);
    assert.deepEqual((await bob.agent(instance.context)).model, { provider: 'faux', modelId: 'one' });
    assert.equal(instance.memory?.jobs, 8);

    await session.setModel('claude-cli', 'sonnet');
    assert.deepEqual((await bob.agent(instance.context)).model, { provider: 'claude-cli', modelId: 'sonnet' });
    assert.equal(instance.memory?.jobs, 2);
    const before = seen.length;
    // Over 512 bytes, so its leaf takes a compaction call.
    await session.send(`a long note: ${'the tide comes in and the tide goes out; '.repeat(20)}`);
    await until(() => seen.includes('claude-cli/haiku') && answers(session) === 3, 'the compaction and the answer', session.chat);
    const after = seen.slice(before);
    assert.ok(after.includes('claude-cli/sonnet'), JSON.stringify(after));
    assert.ok(after.every(each => each.startsWith('claude-cli/')), JSON.stringify(after));
  });

  test('archiveAgents and restoreAgent: the status keeps archived agents with archivedAt, and refusals are readable', async (t) => {
    const { instance, session } = await openRoutes(t);
    await spawnBob(instance, session);
    const before = Date.now();
    assert.deepEqual(await session.archiveAgents({ name: 'bob' }), ['Bob']);
    const archived = session.status().agents.find(agent => agent.name === 'Bob');
    assert.ok(archived?.archivedAt !== undefined && archived.archivedAt >= before && archived.archivedAt <= Date.now(), JSON.stringify(archived));
    assert.deepEqual(await listAgents(instance.harness, instance.context), [], 'hidden from the default list');
    assert.ok(await session.agentChat('Bob'), 'an archived agent\'s chat still opens');
    await assert.rejects(session.restoreAgent('Nobody'), /No agent named Nobody/);
    assert.deepEqual(await session.restoreAgent('Bob'), ['Bob']);
    assert.deepEqual(session.status().agents.map(agent => [agent.name, agent.archivedAt]), [['Bob', undefined]]);
    await assert.rejects(session.restoreAgent('Bob'), /Bob is not archived/);
    assert.deepEqual(await session.archiveAgents({ adhoc: true }), ['Bob']);
    assert.ok(session.status().agents[0]?.archivedAt !== undefined);
  });

  test('setTools on then off: Pi\'s tools, an agent\'s tools, the instructions, and the status', async (t) => {
    const { instance, session } = await openRoutes(t);
    const bob = await spawnBob(instance, session);
    const pi = () => instance.root.agent(instance.context);
    assert.deepEqual([coding(await pi()), coding(await bob.agent(instance.context))], [[], []]);

    await session.setTools(true);
    assert.equal(session.status().toolsEnabled, true);
    assert.deepEqual([coding(await pi()), coding(await bob.agent(instance.context))], [CODING, CODING]);
    assert.match((await pi()).instructions ?? '', /read, write, edit, and bash tools are on for this launch/);
    assert.match((await bob.agent(instance.context)).instructions ?? '', /read, write, edit, and bash tools are on for this launch/);

    await session.setTools(false);
    assert.equal(session.status().toolsEnabled, false);
    assert.deepEqual([coding(await pi()), coding(await bob.agent(instance.context))], [[], []]);
    assert.match((await pi()).instructions ?? '', /Coding tools \(read, write, edit, bash\) are off/);
    assert.deepEqual((await pi()).tools.map(tool => tool.name).sort(),
      ['date', 'delegate', 'delete_agent', 'last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent', 'zoom']);
  });

  test('setThinkingLevel: Pi and its agents take it from the next request, and later launches default to it', async (t) => {
    const { instance, session, efforts, cwd, databasePath, settingsPath } = await openRoutes(t);
    const bob = await spawnBob(instance, session);
    assert.deepEqual(await session.thinkingLevels(), ['off'], 'faux/one does not reason');
    await assert.rejects(session.setThinkingLevel('high'), { message: 'faux/one has no reasoning effort to set; not high.' });
    await session.setModel('faux', 'two');
    assert.deepEqual(await session.thinkingLevels(), ['off', 'minimal', 'low', 'medium', 'high']);
    await session.setThinkingLevel('low');
    assert.equal(session.status().thinkingLevel, 'low');
    assert.equal((await instance.root.agent(instance.context)).thinkingLevel, 'low');
    assert.equal((await bob.agent(instance.context)).thinkingLevel, 'low');
    const before = efforts.length;
    const answered = answers(session);
    await session.send('next');
    await until(() => answers(session) === answered + 1, 'the answer', session.chat);
    assert.deepEqual(efforts.slice(before), ['low']);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { model: 'faux/two', thinkingLevel: 'low' });
    const next = await resolveOptions(parseArgs(['--database', databasePath, '--cwd', cwd]), {});
    assert.equal(next.thinkingLevel, 'low');

    await assert.rejects(session.setThinkingLevel('max'), /faux\/two takes off, minimal, low, medium, high; not max\./);
    await assert.rejects(session.setThinkingLevel('huge'), /not huge/);
    assert.equal(session.status().thinkingLevel, 'low');
  });

  /** Pi on faux/sees (takes images) beside faux/blind (text only). */
  async function openSighted(t: TestContext, first?: FauxResponseStep) {
    const faux = fauxProvider({ models: [{ id: 'sees' }, { id: 'blind', input: ['text'] }] });
    faux.setResponses([...first ? [first] : [], ...Array.from({ length: 10 }, () => fauxAssistantMessage('ok'))]);
    const models = createModels();
    models.setProvider(faux.provider);
    const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-sighted-'));
    const model = { provider: faux.getModel().provider, modelId: 'sees' };
    const instance = await openInstance({ protection: 'unguarded', databasePath: join(cwd, 'chat.sqlite'), cwd, allowTools: false, models, model });
    const session = await createUiSession(instance, { model, thinkingLevel: 'off', allowTools: false }, { refreshMs: 50 });
    t.after(async () => { await session.close(); await instance.close(); await rm(cwd, { recursive: true, force: true }); });
    return { instance, session, provider: model.provider };
  }
  const shot = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' };
  const users = (session: UiSessionHandle) => session.chat.items().filter(item => item.kind === 'user').length;

  test('a retried image send (lost acknowledgement) dedups even after a switch to a model without images', async (t) => {
    const { session, provider } = await openSighted(t);
    await session.send('look', { requestId: 'img-1', images: [shot] });
    await until(() => answers(session) === 1, 'the answer', session.chat);
    await session.setModel(provider, 'blind');
    // The same request ID: already admitted, so the retry resolves and nothing is admitted twice.
    await session.send('look', { requestId: 'img-1', images: [shot] });
    await idle(session);
    assert.equal(users(session), 1);
    // A new request with images is still refused.
    await assert.rejects(session.send('again', { requestId: 'img-2', images: [shot] }), /does not take images/);
    assert.equal(users(session), 1);
  });

  test('an image send during a switch to a model without images waits for it, then refuses', async (t) => {
    const { session, provider } = await openSighted(t);
    const switched = session.setModel(provider, 'blind');
    const sent = session.send('look', { requestId: 'img-during', images: [shot] });
    await switched;
    await assert.rejects(sent, /does not take images; nothing was sent/);
    await idle(session);
    assert.equal(users(session), 0);
  });

  test('a switch to a model without images is refused while a queued message with images waits', async (t) => {
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { session, provider } = await openSighted(t, async () => { await gate; return fauxAssistantMessage('first'); });
    await session.send('one');
    await until(() => session.status().busy, 'busy');
    await session.send('look', { requestId: 'img-queued', images: [shot] });
    await until(() => session.status().queued === 1, 'one queued');
    await assert.rejects(session.setModel(provider, 'blind'), /queued message has images/);
    assert.equal(session.status().model, `${provider}/sees`);
    release();
    await idle(session);
    // Consumed: the switch goes through now.
    await session.setModel(provider, 'blind');
    assert.equal(session.status().model, `${provider}/blind`);
  });

  test('a model switch rechecks images admitted while credentials are pending', async (t) => {
    let releaseRun = (): void => {};
    const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
    const { instance, session, provider } = await openSighted(t, async () => { await runGate; return fauxAssistantMessage('first'); });
    t.after(() => releaseRun());
    await session.send('one');
    await until(() => session.status().busy, 'busy');
    let releaseAuth = (): void => {};
    const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
    const checkAuth = instance.models.checkAuth.bind(instance.models);
    let checking = false;
    t.mock.method(instance.models, 'checkAuth', async (...args: Parameters<typeof checkAuth>) => {
      checking = true;
      await authGate;
      return checkAuth(...args);
    });
    t.after(() => releaseAuth());
    const switched = session.setModel(provider, 'blind');
    const refused = assert.rejects(switched, /queued message has images/);
    await until(() => checking, 'credentials pending');
    // A different caller can admit input without going through this UI session's serial queue.
    await instance.submit('look', { requestId: 'img-auth-pending', images: [shot] });
    await until(() => session.status().queued === 1, 'one queued');
    releaseAuth();
    await refused;
    assert.equal(session.status().model, `${provider}/sees`);
    releaseRun();
    await idle(session);
  });

  test('an inspection switches nothing and writes no settings', async (t) => {
    const { session, settingsPath } = await openRoutes(t, { inspect: true });
    await assert.rejects(session.setModel('faux', 'two'), /inspection cannot change/);
    await assert.rejects(session.setTools(true), /inspection cannot change/);
    await assert.rejects(session.setThinkingLevel('off'), /inspection cannot change/);
    await assert.rejects(stat(settingsPath), { code: 'ENOENT' });
  });
});
