import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { AssistantMessage, Message, TranscriptContext, UserMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { FauxResponseFactory, FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { Conversation, InputSubmissionDraft } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createUniiExtension, openMemory, PROMPT } from '../../src/memory/index.ts';
import { TURN_HEAD } from '../../src/memory/extension.ts';
import type { ContextEntries, RequestApi, Summarizer } from '../../src/memory/index.ts';
import { answerText } from '../../src/runtime/runtime.ts';
import { hash } from '../../src/memory/util.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const fake: Summarizer = async (_system, messages, { node }) => `summary ${node.name}: ${messages[0]?.content.includes('lighthouse') ? 'user asked about the lighthouse' : 'other'}`;
function texts(message: Message | undefined): string[] {
  assert.ok(message, 'no such message');
  if (typeof message.content === 'string') return [message.content];
  const blocks: readonly { type: string; text?: string }[] = message.content;
  return blocks.flatMap(b => (b.type === 'text' && b.text !== undefined ? [b.text] : []));
}

const closers = new WeakMap<TestContext, (() => Promise<void>)[]>();
function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'unii-ext-'));
  closers.set(t, []);
  t.after(async () => {
    for (const close of closers.get(t) ?? []) await close();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function open(t: TestContext, dir: string, responses: FauxResponseStep[],
  { summarize = fake, settleMs = 3000, sqlite = false, compaction = false }:
  { summarize?: Summarizer; settleMs?: number; sqlite?: boolean; compaction?: boolean } = {}) {
  const memory = openMemory(join(dir, 'memory'), { summarize, warn: () => {} });
  const extension = createUniiExtension({
    memory, settleMs, resolveAgentChat: (name, page) => (name === 'Bob' ? 'Bob: wrote build.sh, ran it, exit 0' : name === 'Long' ? `Long's chat, page ${page}` : 'unknown agent'),
  });
  const registry = createRegistry();
  registry.install(extension);
  const catalog = offlineModels(responses);
  const storage = sqlite ? await openNodeSqliteStorage(join(dir, 'chat.sqlite')) : new MemoryStorage();
  const harness = await Harness.open(storage, { models: catalog.models, registry, settings: { compaction: { enabled: compaction } } }, context);
  const agent = { model: catalog.model, tools: extension.tools, instructions: 'USER INSTRUCTIONS' };
  const root = await harness.root(context, { agent });
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await harness.close(context); await memory.close(0); };
  closers.get(t)?.push(close);
  return { memory, harness, root, catalog, agent, close };
}

async function ask(root: Conversation, content: string, extra: Pick<InputSubmissionDraft, 'entry'> = {}): Promise<string> {
  const settled = await (await root.submit({ type: 'input', content, ...extra }, context)).wait(context);
  const answer: unknown = await answerText(root, settled, context);
  assert.equal(typeof answer, 'string');
  return String(answer);
}

const capture = (seen: Message[][], reply: AssistantMessage | ((ctx: TranscriptContext) => AssistantMessage)): FauxResponseFactory =>
  (ctx) => { seen.push(structuredClone(ctx.messages)); return typeof reply === 'function' ? reply(ctx) : reply; };
type BeforeRequest = (request: { readonly messages: readonly Message[] }, api: RequestApi, context: Context) => Promise<{ messages: Message[] } | undefined>;
const hasBeforeRequest = (handlers: object | undefined): handlers is { beforeRequest: BeforeRequest } =>
  handlers !== undefined && 'beforeRequest' in handlers && typeof handlers.beforeRequest === 'function';
function beforeRequestOf(options: Parameters<typeof createUniiExtension>[0]): BeforeRequest {
  const handlers = createUniiExtension(options).hooks?.[0]?.handlers;
  assert.ok(hasBeforeRequest(handlers));
  return handlers.beforeRequest;
}

describe('unii extension in a real Harness (faux model)', { concurrency: false, timeout: 30_000 }, () => {
  test('each turn sees [system] [view] [turn state] [previous exchange] [message], never the raw old transcript', async (t) => {
    const seen: Message[][] = [];
    const long = `LONG ${'lighthouse '.repeat(100)}`;
    const { root, memory } = await open(t, scratch(t), ['A1', 'A2', 'A3'].map(a => capture(seen, fauxAssistantMessage(a))));
    assert.equal(await ask(root, long), 'A1');
    assert.equal(await ask(root, 'second question'), 'A2');
    assert.equal(await ask(root, 'third question'), 'A3');

    assert.deepEqual(seen.map(ms => ms.map(m => m.role)), [['system', 'user'], ['system', 'user'], ['system', 'user']]);
    const [system, user] = seen[2] ?? [];
    assert.ok(system?.role === 'system');
    assert.deepEqual(Object.keys(system.sections ?? {}), ['uniichat', 'instructions'], 'the user\'s instructions follow the recipe prompt');
    assert.equal(system.sections?.uniichat, PROMPT);
    assert.deepEqual(system.toolsAdded?.map(tool => tool.name).sort(), ['date', 'zoom']);
    const [view, state, previous, message] = texts(user);
    assert.equal(view, '<chat>\n0+1|summary 0+1: user asked about the lighthouse\n1+1|pi: A1\n2+1|user: second question\n3+1|pi: A2\n</chat>');
    assert.match(state ?? '', /^<turn>\nnow: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d \(\w+day\)\n<\/turn>$/);
    assert.equal(previous, '<previous_exchange>\nuser: second question\n\npi: A2\n</previous_exchange>');
    assert.equal(message, `${TURN_HEAD}third question`);
    assert.ok(!JSON.stringify(seen[2]).includes('lighthouse lighthouse'), 'the long first message is only a summary now');
    assert.deepEqual(texts(seen[0]?.[1]), ['<chat>\n</chat>', texts(seen[0]?.[1])[1], `${TURN_HEAD}${long}`]);

    assert.deepEqual(memory.log.map(r => `${r.kind}: ${r.text}`), [`user: ${long}`, 'pi: A1', 'user: second question', 'pi: A2', 'user: third question', 'pi: A3']);
  });

  test('zoom end to end; one run\'s requests share the frozen first message; tool calls and results are logged', async (t) => {
    const seen: Message[][] = [];
    const secret = `SECRET-${'z'.repeat(800)}-END`;
    const { root, memory } = await open(t, scratch(t), [
      capture(seen, fauxAssistantMessage('noted')),
      capture(seen, fauxAssistantMessage(fauxToolCall('zoom', { id: 0, n: 1 }, { id: 'call-1' }), { stopReason: 'toolUse' })),
      capture(seen, fauxAssistantMessage(fauxToolCall('zoom', { id: 'Bob' }, { id: 'call-2' }), { stopReason: 'toolUse' })),
      capture(seen, fauxAssistantMessage('the secret ends with -END')),
    ]);
    await ask(root, secret);
    assert.equal(await ask(root, 'what was the secret?'), 'the secret ends with -END');

    assert.deepEqual(seen[2]?.map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
    const result = texts(seen[2]?.[3]).join('');
    assert.ok(result.startsWith('0+1|user: SECRET-') && result.endsWith('-END'));
    assert.equal(texts(seen[3]?.[5]).join(''), 'Bob: wrote build.sh, ran it, exit 0');
    assert.equal(JSON.stringify(seen[1]?.[1]), JSON.stringify(seen[2]?.[1]));
    assert.equal(JSON.stringify(seen[2]?.[1]), JSON.stringify(seen[3]?.[1]), 'the view is rendered once per run');
    const [shown] = texts(seen[1]?.[1]);
    assert.ok(shown !== undefined && !shown.includes('what was the secret'), 'the view is rendered before the new message is logged');

    assert.deepEqual(memory.log.map(r => r.kind), ['user', 'pi', 'user', 'tool', 'echo', 'tool', 'echo', 'pi']);
    assert.equal(memory.at(3).text, 'zoom {"id":0,"n":1}');
    assert.ok(memory.at(4).text.startsWith('zoom: 0+1|user: SECRET-'));
    assert.equal(memory.at(6).text, 'zoom: Bob: wrote build.sh, ran it, exit 0');
    assert.equal(new Set(memory.log.map(r => r.src)).size, memory.log.length);
  });

  test('an agents.report input is logged once, as work, never as user', async (t) => {
    const seen: Message[][] = [];
    const { root, memory } = await open(t, scratch(t), ['ok 1', 'ok 2'].map(a => capture(seen, fauxAssistantMessage(a))));
    memory.report({ name: 'Bob', text: 'built it', id: 'r1' }); // the agents extension's onReport
    const bob = '[Bob]\nbuilt it\n\nFull chat: zoom("Bob")', ann = '[Ann]\nfound the bug\n\nFull chat: zoom("Ann#2")'; // piReportText; Ann is a standing agent, session 2
    await ask(root, bob, { entry: { kind: 'agents.report', data: { name: 'Bob', text: 'built it', id: 'r1' } } });
    await ask(root, ann, { entry: { kind: 'agents.report', data: { name: 'Ann', text: 'found the bug', id: 'r2', session: 2 } } });
    assert.deepEqual(memory.log.map(r => `${r.kind}: ${r.text}`), [`work: ${bob}`, 'pi: ok 1', `work: ${ann}`, 'pi: ok 2'], 'logged as Pi saw it');
    assert.deepEqual(texts(seen[0]?.[1]).at(0), '<chat>\n</chat>', 'the report itself comes whole after the view');
    assert.equal(texts(seen[0]?.[1]).at(-1), `${TURN_HEAD}${bob}`);
    assert.equal(texts(seen[1]?.[1]).at(2), `<previous_exchange>\nwork: ${bob}\n\npi: ok 1\n</previous_exchange>`);
  });

  test('other conversations (spawned agents) are left alone', async (t) => {
    const seen: Message[][] = [];
    const { harness, memory, agent } = await open(t, scratch(t), [capture(seen, fauxAssistantMessage('child answer'))]);
    const child = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context);
    await ask(child, 'child task');
    assert.deepEqual(seen[0]?.map(m => m.role), ['system', 'user']);
    assert.deepEqual(texts(seen[0]?.[1]), ['child task']);
    assert.equal(memory.T, 0);
  });

  test('restart: nothing is logged twice and the next turn continues from the saved memory', async (t) => {
    const dir = scratch(t);
    let seen: Message[][] = [];
    let session = await open(t, dir, [
      capture(seen, fauxAssistantMessage(fauxToolCall('date', { id: 0 }, { id: 'call-d' }), { stopReason: 'toolUse' })),
      capture(seen, fauxAssistantMessage('A1')),
    ], { sqlite: true });
    assert.equal(await ask(session.root, 'Q1'), 'A1');
    const before = session.memory.log.map(r => `${r.kind}: ${r.text}`);
    assert.deepEqual(before.map(r => r.split(':')[0]), ['user', 'tool', 'echo', 'pi']);
    await session.close();

    seen = [];
    session = await open(t, dir, [capture(seen, fauxAssistantMessage('A2'))], { sqlite: true });
    assert.deepEqual(session.memory.log.map(r => `${r.kind}: ${r.text}`), before);
    assert.equal(await ask(session.root, 'Q2'), 'A2');
    assert.deepEqual(session.memory.log.map(r => `${r.kind}: ${r.text}`), [...before, 'user: Q2', 'pi: A2']);
    assert.equal(new Set(session.memory.log.map(r => r.src)).size, 6);
    const [view, , previous, message] = texts(seen[0]?.[1]);
    assert.match(view ?? '', /^<chat>\n0\+1\|user: Q1\n1\+1\|tool: date \{"id":0\}\n2\+1\|echo: date: \d{4}-[^\n]+\n3\+1\|pi: A1\n<\/chat>$/);
    assert.equal(previous, '<previous_exchange>\nuser: Q1\n\npi: A1\n</previous_exchange>');
    assert.equal(message, `${TURN_HEAD}Q2`);
    assert.deepEqual(seen[0]?.map(m => m.role), ['system', 'user']);
  });

  test('a turn waits for pending summaries at most settleMs, then shows placeholders', async (t) => {
    const seen: Message[][] = [];
    let release: (() => void) | undefined;
    const slow = (): Promise<string> => new Promise(r => { release = () => r('late summary'); });
    const { root, memory } = await open(t, scratch(t), ['A1', 'A2'].map(a => capture(seen, fauxAssistantMessage(a))), { summarize: slow, settleMs: 50 });
    await ask(root, `long ${'q'.repeat(900)}`);
    const t0 = Date.now();
    await ask(root, 'next');
    assert.ok(Date.now() - t0 >= 45);
    assert.equal(texts(seen[1]?.[1])[0], '<chat>\n0+1|(not summarized yet: zoom it)\n1+1|pi: A1\n</chat>');
    release?.();
    await memory.settle(1000);
  });

  test('parallel tool calls: each call is logged right before its result; zoom("Name") passes its page', async (t) => {
    const seen: Message[][] = [];
    const { root, memory } = await open(t, scratch(t), [
      fauxAssistantMessage([fauxToolCall('zoom', { id: 'Long', page: 2 }, { id: 'call-z' }), fauxToolCall('date', { id: 0 }, { id: 'call-d' })], { stopReason: 'toolUse' }),
      capture(seen, fauxAssistantMessage('done')),
    ]);
    assert.equal(await ask(root, 'go'), 'done');
    const log = memory.log.map(r => `${r.kind}: ${r.text}`);
    assert.equal(log.length, 6);
    assert.deepEqual([log[0], log[5]], ['user: go', 'pi: done']);
    for (const i of [1, 3]) {
      const call = memory.at(i), result = memory.at(i + 1);
      assert.equal(call.kind, 'tool');
      assert.equal(result.kind, 'echo');
      assert.equal(result.src, call.src?.replace(/^c:/, 'r:'), 'a call and its result are adjacent');
    }
    const zoomed = texts(seen[0]?.find(m => m.role === 'toolResult' && m.toolName === 'zoom')).join('');
    assert.equal(zoomed, 'Long\'s chat, page 2', 'zoom passes its page on');
  });

  test('a failed run is not carried into the next: its message is in the view, the next request carries only the new one', async (t) => {
    const seen: Message[][] = [];
    const { root, memory } = await open(t, scratch(t), [
      capture(seen, fauxAssistantMessage('half an answer', { stopReason: 'error', errorMessage: 'prompt is too long: context window exceeded' })),
      capture(seen, fauxAssistantMessage('A2')),
    ]);
    const settled = await (await root.submit({ type: 'input', content: 'Q1' }, context)).wait(context);
    assert.equal(settled?.status, 'unanswered');
    assert.equal(await ask(root, 'Q2'), 'A2');
    assert.deepEqual(seen[1]?.map(m => m.role), ['system', 'user'], 'Q1 is not sent again raw');
    const [view, , previous, message] = texts(seen[1]?.[1]);
    assert.equal(view, '<chat>\n0+1|user: Q1\n1+1|pi: half an answer [cut off: prompt is too long: context window exceeded]\n</chat>');
    assert.equal(previous, '<previous_exchange>\nuser: Q1\n\npi: half an answer\n[cut off: prompt is too long: context window exceeded]\n</previous_exchange>');
    assert.equal(message, `${TURN_HEAD}Q2`);
    assert.deepEqual(memory.log.map(r => r.kind), ['user', 'pi', 'user', 'pi']);
  });

  test('a stopped run: its partial reply is logged with a cut mark and its unanswered call alone, before the next input', async (t) => {
    const memory = openMemory(join(scratch(t), 'memory'), { summarize: fake, warn: () => {} });
    closers.get(t)?.push(() => memory.close(0));
    memory.append({ kind: 'user', text: 'Q1', src: 'e:1' });
    const asked: UserMessage = { role: 'user', content: 'Q1', timestamp: 1 };
    const partial = fauxAssistantMessage([fauxText('partial'), fauxThinking('never logged'), fauxToolCall('date', { id: 0 }, { id: 'call-p' })], { stopReason: 'aborted', timestamp: 2 });
    const next: UserMessage = { role: 'user', content: 'Q2', timestamp: 3 };
    const view: ContextEntries = {
      entries: [{ id: 1, kind: 'pi.user' }, { id: 2, kind: 'pi.assistant', byTaskId: 7, model: [partial] }, { id: 3, kind: 'pi.user' }],
      contributions: [[asked], [], [next]], // pi-durable keeps the aborted reply out of the model's context
    };
    const api: RequestApi = { conversationId: ROOT_CONVERSATION_ID, taskId: 9, context: async () => view };
    const out = await beforeRequestOf({ memory, atWork: () => ['Bob', 'Ann'] })(
      { messages: [{ role: 'system', content: 'S', timestamp: 0 }, asked, next] }, api, context);
    assert.deepEqual(out?.messages.map(m => m.role), ['system', 'user']);
    const [shown, state, message] = texts(out?.messages[1]);
    assert.equal(shown, '<chat>\n0+1|user: Q1\n1+1|pi: partial [cut off: stopped]\n2+1|tool: date {"id":0}\n</chat>');
    assert.match(state ?? '', /\nagents at work: Bob, Ann\n<\/turn>$/);
    assert.equal(message, `${TURN_HEAD}Q2`);
    assert.deepEqual(memory.log.map(r => r.src), ['e:1', `a:2:${hash('partial')}`, 'c:call-p', 'e:3']);
  });

  test('a huge paste: its first parts are summarized into the view, the message is only its tail; compactions get no tools', async (t) => {
    const seen: Message[][] = [];
    const asked: { system: string; tools: boolean }[] = [];
    const spy: Summarizer = async (system, messages, options) => {
      asked.push({ system, tools: options.tools !== undefined });
      return fake(system, messages, options);
    };
    const { root, memory } = await open(t, scratch(t), ['A1', 'A2'].map(a => capture(seen, fauxAssistantMessage(a))), { summarize: spy });
    assert.equal(await ask(root, 'hi'), 'A1');
    const paste = `HEAD-${'a'.repeat(150_000)}${'b'.repeat(150_000)}-TAIL`;
    assert.equal(await ask(root, paste), 'A2');

    const parts = memory.log.filter(r => r.kind === 'user').length - 1;
    assert.equal(parts, 11, 'the paste is logged whole, split at 30,000 characters');
    const k = memory.whole(2);
    assert.ok(k > 2 && k < memory.T - 1);
    assert.deepEqual(seen[1]?.map(m => m.role), ['system', 'user']);
    const [view, , message] = texts(seen[1]?.[1]);
    assert.equal(message, TURN_HEAD + memory.say(k, 2 + parts));
    assert.ok(message?.endsWith('-TAIL') && !message.includes('HEAD-'));
    assert.ok(Buffer.byteLength(message ?? '') <= 128_000 + TURN_HEAD.length);
    assert.match(view ?? '', /\n2\+1\|summary 2\+1: other\n/, 'the head is in the view, summarized');
    assert.ok(!(view ?? '').includes(`\n${k}+1|`), 'the tail is not');
    assert.equal(texts(seen[1]?.[1]).length, 3, 'no previous exchange inside the paste');
    assert.ok(asked.length > 0 && asked.every(a => !a.tools && a.system.includes(PROMPT)), 'compactions: the turns\' system prompt, no tools');
  });

  test('with pi-durable compaction on (for agents, as the host runs it), a compaction of the root is declined', async (t) => {
    const { root, harness, catalog } = await open(t, scratch(t), ['A1', 'A2'].map(a => fauxAssistantMessage(a)), { compaction: true });
    await ask(root, 'Q1');
    await ask(root, 'Q2');
    const calls = catalog.faux.state.callCount;
    await harness.waitForTask(await root.compact(undefined, context), context);
    const kinds = (await root.entries({ order: 'ascending' }, 256, undefined, context)).items.map(e => e.kind);
    assert.ok(!kinds.includes('pi.compaction'), 'no compaction entry on the root');
    assert.equal(catalog.faux.state.callCount, calls, 'no summarization request');
  });

  test('a run resumed after a restart renders the view before its own, already logged, messages', async (t) => {
    const memory = openMemory(join(scratch(t), 'memory'), { summarize: fake, warn: () => {} });
    closers.get(t)?.push(() => memory.close(0));
    memory.append({ kind: 'user', text: 'old question', src: 'e:1' });
    memory.append({ kind: 'pi', text: 'old answer', src: `a:2:${hash('old answer')}` });
    const user: UserMessage = { role: 'user', content: 'new question', timestamp: 3 };
    const asked: UserMessage = { role: 'user', content: 'old question', timestamp: 1 };
    const answered = fauxAssistantMessage('old answer', { timestamp: 2 });
    const view: ContextEntries = { entries: [{ id: 1, kind: 'pi.user' }, { id: 2, kind: 'pi.assistant' }, { id: 5, kind: 'pi.user' }],
      contributions: [[asked], [answered], [user]] };
    const api: RequestApi = { conversationId: ROOT_CONVERSATION_ID, context: async () => view };
    const request = { messages: [{ role: 'system', content: 'S', timestamp: 0 }, asked, answered, user] satisfies Message[] };
    const before = async (): Promise<{ messages: Message[] } | undefined> => {
      const handlers = createUniiExtension({ memory }).hooks?.[0]?.handlers;
      assert.ok(hasBeforeRequest(handlers));
      return handlers.beforeRequest(request, api, context);
    };
    const first = await before();
    const T = memory.T;
    const second = await before(); // a fresh extension: the process restarted mid-run
    assert.ok(first && second);
    assert.equal(memory.T, T, 'nothing logged twice');
    assert.equal(texts(first.messages[1])[0], texts(second.messages[1])[0]);
    assert.equal(texts(second.messages[1])[0], '<chat>\n0+1|user: old question\n1+1|pi: old answer\n</chat>');
    assert.deepEqual(first.messages.map(m => m.role), ['system', 'user']);
  });
});
