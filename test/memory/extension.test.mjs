import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createUniiExtension, openMemory, PROMPT } from '../../src/memory/index.mjs';
import { answerText } from '../../src/runtime/runtime.mjs';
import { hash } from '../../src/memory/util.mjs';
import { offlineModels } from '../fixtures/faux-model.mjs';

const fake = async (_system, messages, { node }) => `summary ${node.name}: ${messages[0].content.includes('lighthouse') ? 'user asked about the lighthouse' : 'other'}`;
const texts = message => typeof message.content === 'string' ? [message.content]
  : message.content.filter(b => b.type === 'text').map(b => b.text);

const closers = new WeakMap();
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'unii-ext-'));
  closers.set(t, []);
  t.after(async () => {
    for (const close of closers.get(t)) await close();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function open(t, dir, responses, { summarize = fake, settleMs = 3000, sqlite = false } = {}) {
  const memory = openMemory(join(dir, 'memory'), { summarize, warn: () => {} });
  const extension = createUniiExtension({
    memory, settleMs, resolveAgentChat: name => (name === 'Bob' ? 'Bob: wrote build.sh, ran it, exit 0' : 'unknown agent'),
  });
  const registry = createRegistry();
  registry.install(extension);
  const catalog = offlineModels(responses);
  const storage = sqlite ? await openNodeSqliteStorage(join(dir, 'chat.sqlite')) : new MemoryStorage();
  const harness = await Harness.open(storage, { models: catalog.models, registry, settings: { compaction: { enabled: false } } }, context);
  const agent = { model: catalog.model, tools: extension.tools, instructions: 'USER INSTRUCTIONS' };
  const root = await harness.root(context, { agent });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await harness.close(context); await memory.close(0); };
  closers.get(t).push(close);
  return { memory, harness, root, catalog, agent, close };
}

async function ask(root, content, extra = {}) {
  const settled = await (await root.submit({ type: 'input', content, ...extra }, context)).wait(context);
  return answerText(root, settled, context);
}

const capture = (seen, reply) => (ctx) => { seen.push(structuredClone(ctx.messages)); return typeof reply === 'function' ? reply(ctx) : reply; };

describe('unii extension in a real Harness (faux model)', { concurrency: false, timeout: 30_000 }, () => {
  test('each turn sees [system] [view] [turn state] [previous exchange] [message], never the raw old transcript', async (t) => {
    const seen = [];
    const long = `LONG ${'lighthouse '.repeat(100)}`;
    const { root, memory } = await open(t, scratch(t), ['A1', 'A2', 'A3'].map(a => capture(seen, fauxAssistantMessage(a))));
    assert.equal(await ask(root, long), 'A1');
    assert.equal(await ask(root, 'second question'), 'A2');
    assert.equal(await ask(root, 'third question'), 'A3');

    assert.deepEqual(seen.map(ms => ms.map(m => m.role)), [['system', 'user'], ['system', 'user'], ['system', 'user']]);
    const [system, user] = seen[2];
    assert.deepEqual(Object.keys(system.sections), ['uniichat', 'instructions'], 'the user\'s instructions follow the recipe prompt');
    assert.equal(system.sections.uniichat, PROMPT);
    assert.deepEqual(system.toolsAdded.map(tool => tool.name).sort(), ['date', 'zoom']);
    const [view, state, previous, message] = texts(user);
    assert.equal(view, '<chat>\n0+1|summary 0+1: user asked about the lighthouse\n1+1|pi: A1\n2+1|user: second question\n3+1|pi: A2\n</chat>');
    assert.match(state, /^<turn>\nnow: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d \(\w+day\)\n<\/turn>$/);
    assert.equal(previous, '<previous_exchange>\nuser: second question\n\npi: A2\n</previous_exchange>');
    assert.equal(message, 'third question');
    assert.ok(!JSON.stringify(seen[2]).includes('lighthouse lighthouse'), 'the long first message is only a summary now');
    assert.deepEqual(texts(seen[0][1]), ['<chat>\n</chat>', texts(seen[0][1])[1], long]);

    assert.deepEqual(memory.log.map(r => `${r.kind}: ${r.text}`), [`user: ${long}`, 'pi: A1', 'user: second question', 'pi: A2', 'user: third question', 'pi: A3']);
  });

  test('zoom end to end; one run\'s requests share the frozen first message; tool calls and results are logged', async (t) => {
    const seen = [];
    const secret = `SECRET-${'z'.repeat(800)}-END`;
    const { root, memory } = await open(t, scratch(t), [
      capture(seen, fauxAssistantMessage('noted')),
      capture(seen, fauxAssistantMessage(fauxToolCall('zoom', { id: 0, n: 1 }, { id: 'call-1' }), { stopReason: 'toolUse' })),
      capture(seen, fauxAssistantMessage(fauxToolCall('zoom', { id: 'Bob' }, { id: 'call-2' }), { stopReason: 'toolUse' })),
      capture(seen, fauxAssistantMessage('the secret ends with -END')),
    ]);
    await ask(root, secret);
    assert.equal(await ask(root, 'what was the secret?'), 'the secret ends with -END');

    assert.deepEqual(seen[2].map(m => m.role), ['system', 'user', 'assistant', 'toolResult']);
    const result = texts(seen[2][3]).join('');
    assert.ok(result.startsWith('0+1|user: SECRET-') && result.endsWith('-END'));
    assert.equal(texts(seen[3][5]).join(''), 'Bob: wrote build.sh, ran it, exit 0');
    assert.equal(JSON.stringify(seen[1][1]), JSON.stringify(seen[2][1]));
    assert.equal(JSON.stringify(seen[2][1]), JSON.stringify(seen[3][1]), 'the view is rendered once per run');
    assert.ok(!texts(seen[1][1])[0].includes('what was the secret'), 'the view is rendered before the new message is logged');

    assert.deepEqual(memory.log.map(r => r.kind), ['user', 'pi', 'user', 'tool', 'echo', 'tool', 'echo', 'pi']);
    assert.equal(memory.log[3].text, 'zoom {"id":0,"n":1}');
    assert.ok(memory.log[4].text.startsWith('zoom: 0+1|user: SECRET-'));
    assert.equal(memory.log[6].text, 'zoom: Bob: wrote build.sh, ran it, exit 0');
    assert.equal(new Set(memory.log.map(r => r.src)).size, memory.log.length);
  });

  test('an agents.report input is logged once, as work, never as user', async (t) => {
    const seen = [];
    const { root, memory } = await open(t, scratch(t), ['ok 1', 'ok 2'].map(a => capture(seen, fauxAssistantMessage(a))));
    memory.report({ name: 'Bob', text: 'built it', id: 'r1' }); // the agents extension's onReport
    await ask(root, '[Bob] built it', { entry: { kind: 'agents.report', data: { name: 'Bob', text: 'built it', id: 'r1' } } });
    await ask(root, '[Ann] found the bug', { entry: { kind: 'agents.report', data: { name: 'Ann', text: 'found the bug', id: 'r2' } } });
    assert.deepEqual(memory.log.map(r => `${r.kind}: ${r.text}`), ['work: [Bob] built it', 'pi: ok 1', 'work: [Ann] found the bug', 'pi: ok 2']);
    assert.deepEqual(texts(seen[0][1]).at(0), '<chat>\n</chat>', 'the report itself comes whole after the view');
    assert.equal(texts(seen[0][1]).at(-1), '[Bob] built it');
    assert.equal(texts(seen[1][1]).at(2), '<previous_exchange>\nwork: [Bob] built it\n\npi: ok 1\n</previous_exchange>');
  });

  test('other conversations (spawned agents) are left alone', async (t) => {
    const seen = [];
    const { harness, memory, agent } = await open(t, scratch(t), [capture(seen, fauxAssistantMessage('child answer'))]);
    const child = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context);
    await ask(child, 'child task');
    assert.deepEqual(seen[0].map(m => m.role), ['system', 'user']);
    assert.deepEqual(texts(seen[0][1]), ['child task']);
    assert.equal(memory.T, 0);
  });

  test('restart: nothing is logged twice and the next turn continues from the saved memory', async (t) => {
    const dir = scratch(t);
    let seen = [];
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
    const [view, , previous, message] = texts(seen[0][1]);
    assert.match(view, /^<chat>\n0\+1\|user: Q1\n1\+1\|tool: date \{"id":0\}\n2\+1\|echo: date: \d{4}-[^\n]+\n3\+1\|pi: A1\n<\/chat>$/);
    assert.equal(previous, '<previous_exchange>\nuser: Q1\n\npi: A1\n</previous_exchange>');
    assert.equal(message, 'Q2');
    assert.deepEqual(seen[0].map(m => m.role), ['system', 'user']);
  });

  test('a turn waits for pending summaries at most settleMs, then shows placeholders', async (t) => {
    const seen = [];
    let release;
    const slow = () => new Promise(r => { release = () => r('late summary'); });
    const { root, memory } = await open(t, scratch(t), ['A1', 'A2'].map(a => capture(seen, fauxAssistantMessage(a))), { summarize: slow, settleMs: 50 });
    await ask(root, `long ${'q'.repeat(900)}`);
    const t0 = Date.now();
    await ask(root, 'next');
    assert.ok(Date.now() - t0 >= 45);
    assert.equal(texts(seen[1][1])[0], '<chat>\n0+1|(not summarized yet: zoom it)\n1+1|pi: A1\n</chat>');
    release();
    await memory.settle(1000);
  });

  test('a run resumed after a restart renders the view before its own, already logged, messages', async (t) => {
    const memory = openMemory(join(scratch(t), 'memory'), { summarize: fake, warn: () => {} });
    closers.get(t).push(() => memory.close(0));
    memory.append({ kind: 'user', text: 'old question', src: 'e:1' });
    memory.append({ kind: 'pi', text: 'old answer', src: `a:2:${hash('old answer')}` });
    const user = { role: 'user', content: 'new question', timestamp: 3 };
    const old = [{ role: 'user', content: 'old question', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], stopReason: 'stop', timestamp: 2 }];
    const view = { entries: [{ id: 1, kind: 'pi.user' }, { id: 2, kind: 'pi.assistant' }, { id: 5, kind: 'pi.user' }],
      contributions: [[old[0]], [old[1]], [user]] };
    const api = { conversationId: 1, context: async () => view };
    const request = { messages: [{ role: 'system', content: 'S', timestamp: 0 }, ...old, user] };
    const before = () => createUniiExtension({ memory }).hooks[0].handlers.beforeRequest(request, api, context);
    const first = await before();
    const T = memory.T;
    const second = await before(); // a fresh extension: the process restarted mid-run
    assert.equal(memory.T, T, 'nothing logged twice');
    assert.equal(texts(first.messages[1])[0], texts(second.messages[1])[0]);
    assert.equal(texts(second.messages[1])[0], '<chat>\n0+1|user: old question\n1+1|pi: old answer\n</chat>');
    assert.deepEqual(first.messages.map(m => m.role), ['system', 'user']);
  });
});
