import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  AgentDoc, type AgentChange, AssistantEntry, type Conversation, type ConversationId, createRegistry, type Cursor, defineEntry, type EntryRecord,
  Harness, type JsonObject, LiveDoc, type ModelRef, ROOT_CONVERSATION_ID, type Storage, type TaskId, type ToolExecutionApi,
  type ToolRegistration, ToolResultEntry, type Tx,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import {
  type AgentsOptions, AgentsDoc, agentTranscript, createAgentsExtension, listAgents, MESSAGE_KIND, missingKits, REPORT_KIND,
  type Roster, stopAgents, syncAgents,
} from '../../src/agents/index.ts';
import { call, router, say, type Script } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

// A session per task (ADR 0027): Pi's delegate(agent, task) starts a standing agent's new task in a new conversation.

const MessageEntry = defineEntry<{ from: string; text: string }>(MESSAGE_KIND);
const ReportEntry = defineEntry<{ name: string; text: string; id: TaskId; session?: number }>(REPORT_KIND);
const context = BACKGROUND_CONTEXT;

interface Instance {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly context: Context;
  readonly storage: Storage;
  readonly tools: Readonly<Record<string, ToolRegistration>>;
  /** What the launch passed to syncAgents, and the agents' tools Pi has. */
  readonly setup: AgentsOptions;
  readonly agentTools: readonly ToolRegistration[];
  close(): Promise<void>;
}

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-sessions-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'sessions.sqlite') };
}

/** As test/fixtures/agents-instance.ts's openAgents, with a roster: the launch creates the standing agents. */
async function open({ databasePath, cwd, script, roster, hooks = {}, coding = false }: {
  readonly databasePath: string; readonly cwd: string; readonly script: Script;
  readonly roster: (model: ModelRef) => Roster; readonly hooks?: AgentsOptions;
  /** Pi's coding tools on, and the coding kit there for the roster. */
  readonly coding?: boolean;
}): Promise<Instance> {
  const { models, model } = offlineModels(router(script));
  const setup: AgentsOptions = { ...hooks, roster: roster(model), ...coding ? { kits: { coding: { tools: CodingTools.tools ?? [] } } } : {} };
  const Agents = createAgentsExtension(setup);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Agents);
  const agent: AgentChange = { cwd, model, thinkingLevel: 'off', extensions: [CodingTools, Agents],
    tools: [...Agents.tools, ...coding ? CodingTools.tools ?? [] : []], modelTools: null,
    instructions: 'Offline sessions test.' };
  const storage = await SqliteStorage.open(await openNodeSqliteDatabase(databasePath));
  const harness = await Harness.open(storage, { models, registry,
    env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }) }, context);
  const root = await harness.root(context, { agent });
  await root.configure(agent, context);
  await syncAgents(harness, context, setup);
  const tools = Object.fromEntries(Agents.tools.map((tool): [string, ToolRegistration] => [tool.name, tool]));
  return { harness, root, context, storage, tools, setup, agentTools: Agents.tools, close: () => harness.close(context) };
}

/** Run one of the agents' tools directly, as tool call `taskId` of `conversationId`; its text result. */
async function execute(instance: Instance, name: string, args: JsonObject, taskId: TaskId, conversationId: ConversationId = ROOT_CONVERSATION_ID) {
  const tool = instance.tools[name];
  assert.ok(tool, `no tool ${name}`);
  const { harness } = instance;
  const unused = (): never => { throw new Error('not used by the agents\' tools'); };
  // As in a tool call, a task created without a conversation belongs to the calling one.
  const owned = (tx: Tx): Tx => new Proxy(tx, {
    get(target, key) {
      if (key === 'createTask') {
        const create: Tx['createTask'] = (task, input, options) => target.createTask(task, input, { conversationId, ...options });
        return create;
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  });
  const api: ToolExecutionApi = {
    taskId, conversationId, callId: 'direct', registry: createRegistry().snapshot(), models: offlineModels().models,
    env: undefined, outputWindow: undefined,
    snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness),
    watchDoc: harness.watchDoc.bind(harness),
    commit: <T>(change: (tx: Tx) => T | Promise<T>, at: Context) => harness.commit((tx) => change(owned(tx)), at),
    conversation: harness.conversation.bind(harness),
    agent: unused, output: unused, retainedOutput: unused, diagnostic: unused, details: unused, memo: unused,
    createTask: unused, getTask: unused, waitForTask: unused, executeTool: unused, now: Date.now,
  };
  const result = await tool.execute(args, api, context);
  const block = result.output?.[0];
  assert.ok(block?.type === 'text');
  return block.text;
}

const coderOnly = (model: ModelRef): Roster => ({ Coder: { model, thinkingLevel: 'medium', tools: [] } });

async function settle({ harness }: Instance, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}
async function until(check: () => Promise<boolean>, what: string, ms = 15_000) {
  for (const end = Date.now() + ms; !await check(); await delay(10)) assert.ok(Date.now() < end, what);
}

async function entries({ harness }: Instance, conversationId: ConversationId) {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}
const record = async ({ harness }: Instance, name: string) => {
  const agent = (await harness.snapshot(AgentsDoc, context))?.agents[name];
  assert.ok(agent, `no agent ${name}`);
  return agent;
};
const textOf = (content: string | readonly (TextContent | ImageContent)[]) => typeof content === 'string' ? content
  : content.map((block) => block.type === 'text' ? block.text : '').join('');
const userTexts = (list: readonly EntryRecord[]) => list.flatMap((entry) => entry.model ?? [])
  .flatMap((message) => message.role === 'user' ? [textOf(message.content)] : []);
const reportsIn = async (instance: Instance, conversationId: ConversationId) =>
  (await entries(instance, conversationId)).filter((entry) => ReportEntry.is(entry))
    .flatMap((entry) => ReportEntry.is(entry) ? [`${entry.data.name}: ${entry.data.text}`] : []);
const toolResults = async (instance: Instance, conversationId: ConversationId) => (await entries(instance, conversationId))
  .filter((entry) => ToolResultEntry.is(entry)).flatMap((entry) => entry.model ?? [])
  .flatMap((message) => message.role === 'toolResult' ? [textOf(message.content)] : []);
const offered = async ({ harness }: Instance, conversationId: ConversationId) =>
  (await (await harness.conversation(conversationId, context))?.agent(context))?.tools.map((tool) => tool.name).sort();

describe('delegate: a session per task (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('each task gets a session; busy refuses; send_message goes to the current one; zoom reads any', async (t) => {
    const options = await temporary(t);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const instance = await open({ ...options, roster: coderOnly, hooks: { initialContext: ({ task }) => `<view>for ${task}</view>` },
      script: {
        Pi: ({ user, last }) => {
          if (last) return say('ok');
          if (user === 'one') return call(['delegate', { agent: 'Coder', task: 'Task one.' }]);
          if (user === 'two') return call(['delegate', { agent: 'Coder', task: 'Task two.' }]);
          if (user === 'three') return call(['delegate', { agent: 'coder', task: 'Task three.' }]);
          if (user === 'steer') return call(['send_message', { to: 'Coder', text: 'Also tests.' }]);
          if (user === 'lead') return call(['spawn_agent', { name: 'Lead', task: 'Wait.' }]);
          return say('noted');
        },
        Coder: async ({ user }) => {
          if (user.endsWith('Task one.')) return say('One done.');
          if (user.endsWith('Task two.')) { started.resolve(); await gate.promise; return say('Two done.'); }
          if (user === '[from Pi] Also tests.') return say('Tests added.');
          throw new Error(`Coder: unexpected ${user}`);
        },
        Lead: () => say('Lead here.'),
      } });
    try {
      const { root } = instance;
      const ask = async (content: string) => (await root.submit({ type: 'input', content }, context)).wait(context);
      const first = (await record(instance, 'Coder')).conversationId;

      // The first task takes the launch's never-used conversation: session 1.
      await ask('one');
      await settle(instance);
      let coder = await record(instance, 'Coder');
      assert.deepEqual([coder.conversationId, coder.past], [first, []]);
      assert.deepEqual(userTexts((await entries(instance, first)).filter((entry) => MessageEntry.is(entry))),
        ['<view>for Task one.</view>\n\n[from Pi] Task one.']);

      // The second is a new conversation, the first kept in past, derived before its first input.
      await ask('two');
      await started.promise;
      coder = await record(instance, 'Coder');
      const second = coder.conversationId;
      assert.notEqual(second, first);
      assert.deepEqual(coder.past, [first]);
      assert.deepEqual(await offered(instance, second), ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent']);
      assert.ok((await offered(instance, ROOT_CONVERSATION_ID))?.includes('delegate'), 'Pi has delegate');
      assert.deepEqual(userTexts((await entries(instance, second)).filter((entry) => MessageEntry.is(entry))),
        ['<view>for Task two.</view>\n\n[from Pi] Task two.']);

      // Right after the delegate, the new session has no answer yet: last_message and list_agents show the newest one.
      const mint = () => instance.storage.mintId<TaskId>();
      assert.equal(await execute(instance, 'last_message', { name: 'Coder' }, await mint()),
        'Coder is busy. Last message (session 1, an earlier task):\nOne done.');
      assert.ok((await execute(instance, 'list_agents', {}, await mint())).includes('- Coder (main, parent Pi, standing) busy — last (session 1): One done.'));

      // Busy: refused, nothing changes.
      await ask('three');
      assert.equal((await toolResults(instance, ROOT_CONVERSATION_ID)).at(-1),
        'Coder is busy with its current task; send_message to steer it, or stop_agent first.');
      assert.deepEqual(await record(instance, 'Coder'), coder);
      gate.resolve();
      await settle(instance);

      // send_message reaches the current session only.
      await ask('steer');
      await settle(instance);
      assert.ok(userTexts(await entries(instance, second)).includes('[from Pi] Also tests.'));
      assert.ok(!userTexts(await entries(instance, first)).some((each) => each.includes('Also tests.')));
      assert.deepEqual(await reportsIn(instance, ROOT_CONVERSATION_ID), ['Coder: One done.', 'Coder: Two done.', 'Coder: Tests added.']);
      // Each report to Pi links the session it came from, which a later delegate does not change.
      const piTexts = userTexts(await entries(instance, ROOT_CONVERSATION_ID));
      assert.ok(piTexts.includes('[Coder]\nOne done.\n\nFull chat: zoom("Coder#1")'));
      assert.ok(piTexts.includes('[Coder]\nTwo done.\n\nFull chat: zoom("Coder#2")'));
      assert.ok(piTexts.includes('[Coder]\nTests added.\n\nFull chat: zoom("Coder#2")'));
      assert.deepEqual((await entries(instance, ROOT_CONVERSATION_ID)).flatMap((entry) => ReportEntry.is(entry) ? [entry.data.session] : []),
        [1, 2, 2], 'the entry keeps it for the memory');
      assert.equal(await execute(instance, 'last_message', { name: 'Coder' }, await mint()), 'Coder is idle. Last message:\nTests added.');

      // zoom("Coder") is the current session; "Coder#n" any, 1 the oldest.
      const current = await agentTranscript(instance.harness, 'Coder', context);
      assert.match(current, /^session 2 of 2 \(current\)\n\n0\|note: .*\n\n1\|user: \[from Pi\] Task two\.\n\n2\|Coder: Two done\./);
      assert.equal(await agentTranscript(instance.harness, 'coder#2', context), current);
      const oldest = await agentTranscript(instance.harness, 'Coder#1', context);
      assert.match(oldest, /^session 1 of 2\n\n0\|note: .*\n\n1\|user: \[from Pi\] Task one\.\n\n2\|Coder: One done\.$/);
      assert.equal(await agentTranscript(instance.harness, 'Coder#1', context, 1), oldest, 'a short chat is one page');
      assert.equal(await agentTranscript(instance.harness, 'Coder#3', context), 'No session 3: Coder has 2 sessions.');
      assert.equal(await agentTranscript(instance.harness, 'Coder#0', context), 'No session 0: Coder has 2 sessions.');

      // An ad-hoc agent has no delegate and no session line.
      await ask('lead');
      await settle(instance);
      const lead = await record(instance, 'Lead');
      assert.deepEqual(await offered(instance, lead.conversationId), ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent']);
      assert.match(await agentTranscript(instance.harness, 'Lead', context), /^0\|note: /);
      assert.equal(lead.past, undefined);
    } finally {
      await instance.close();
    }
  });

  test('a busy sub keeps its task running; an old task\'s subs never reach the new session', async (t) => {
    const options = await temporary(t);
    const helping = Promise.withResolvers<void>();
    const instance = await open({ ...options, roster: coderOnly, script: {
      Pi: ({ user, last }) => {
        if (last) return say('ok');
        if (user === 'one') return call(['delegate', { agent: 'Coder', task: 'Task one.' }]);
        if (user === 'two') return call(['delegate', { agent: 'Coder', task: 'Task two.' }]);
        if (user === 'three') return call(['delegate', { agent: 'Coder', task: 'Task three.' }]);
        if (user === 'ping') return call(['send_message', { to: 'Helper', text: 'Ping.' }]);
        return say('noted');
      },
      Coder: ({ user, last }) => {
        if (user.endsWith('Task one.')) return last ? say('Helper is on it.') : call(['spawn_agent', { name: 'Helper', task: 'Slow.' }]);
        if (user.endsWith('Task two.')) return say('Two done.');
        if (user.endsWith('Task three.')) return last ? say('Asked Helper.') : call(['send_message', { to: 'Helper', text: 'Come back.' }]);
        if (user.startsWith('[Helper]')) return say(`Coder got ${user}`);
        return undefined;
      },
      Helper: async ({ user, signal }) => {
        if (user === '[from Coder] Slow.') {
          helping.resolve();
          await delay(60_000, undefined, { signal }).catch(() => {});
          return say('never');
        }
        if (user === '[from Coder] Come back.') return say('Back.');
        throw new Error(`Helper: unexpected ${user}`);
      },
    } });
    try {
      const ask = async (content: string) => (await instance.root.submit({ type: 'input', content }, context)).wait(context);
      await ask('one');
      await helping.promise;
      const first = (await record(instance, 'Coder')).conversationId;
      assert.equal((await record(instance, 'Helper')).session, first, 'a sub of a standing agent works for its session');
      await until(async () => (await listAgents(instance.harness, context)).filter((agent) => agent.busy).map((agent) => agent.name).join() === 'Helper'
        && (await reportsIn(instance, ROOT_CONVERSATION_ID)).length === 1
        && (await instance.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run === undefined, 'Coder never reported');

      // Coder is idle, but its task goes on in Helper: delegate refuses, and nothing changes.
      await ask('two');
      assert.equal((await toolResults(instance, ROOT_CONVERSATION_ID)).at(-1),
        'Coder\'s current task is still running (its sub agent Helper is busy); send_message to steer it, or stop_agent first.');
      assert.deepEqual([(await record(instance, 'Coder')).conversationId, (await record(instance, 'Coder')).past], [first, []]);

      // Stopped, the sub never answers, and nothing reaches either session; then the delegate goes through.
      assert.deepEqual(await stopAgents(instance.harness, context, 'Helper'), ['Helper']);
      await ask('two');
      await settle(instance);
      const second = (await record(instance, 'Coder')).conversationId;
      const helper = await record(instance, 'Helper');
      assert.deepEqual([helper.role, helper.parent, helper.session], ['sub', 'Coder', first], 'kept, stopped, with its session');
      assert.deepEqual((await entries(instance, helper.conversationId)).filter((entry) => AssistantEntry.is(entry)), []);

      // Pi cannot wake the old sub, whose report would reach no one; the sub cannot message its main agent either.
      await ask('ping');
      await settle(instance);
      assert.equal((await toolResults(instance, ROOT_CONVERSATION_ID)).at(-1),
        'Helper worked for an earlier task of Coder, which is over: its report would reach no one. Coder can take it on by messaging it.');
      assert.ok(!userTexts(await entries(instance, helper.conversationId)).includes('[from Pi] Ping.'));
      assert.equal(await execute(instance, 'send_message', { to: 'Coder', text: 'Still here.' }, await instance.storage.mintId<TaskId>(),
        helper.conversationId), 'Coder has moved on to a new task; the one you worked for is over.');
      assert.deepEqual(await reportsIn(instance, second), []);
      assert.deepEqual(await reportsIn(instance, first), []);
      assert.deepEqual(await reportsIn(instance, ROOT_CONVERSATION_ID), ['Coder: Helper is on it.', 'Coder: Two done.']);

      // A later session that messages the sub takes it on: its report comes there.
      await ask('three');
      await settle(instance);
      const third = (await record(instance, 'Coder')).conversationId;
      assert.deepEqual((await record(instance, 'Coder')).past, [first, second]);
      assert.equal((await record(instance, 'Helper')).session, third);
      assert.deepEqual(await reportsIn(instance, third), ['Helper: Back.']);
      assert.deepEqual(await reportsIn(instance, second), []);
      assert.deepEqual((await reportsIn(instance, ROOT_CONVERSATION_ID)).slice(2), ['Coder: Asked Helper.', 'Coder: Coder got [Helper] Back.']);
    } finally {
      await instance.close();
    }
  });

  test('delegate is replay-safe across a reopen, delivers its task once, and refuses non-standing agents and non-root callers', async (t) => {
    const options = await temporary(t);
    let views = 0;
    const script: Script = {
      Pi: ({ user, last }) => user.startsWith('[') ? say('noted')
        : user === 'lead' ? (last ? say('ok') : call(['spawn_agent', { name: 'Lead', task: 'Wait.' }])) : undefined,
      Coder: ({ user }) => user.endsWith('Do it.') ? say('Did it.') : user.endsWith('Next.') ? say('Next done.') : undefined,
      Lead: () => say('Lead here.'),
    };
    const reopen = () => open({ ...options, roster: coderOnly, script, hooks: { initialContext: () => { views++; return '<view/>'; } } });
    let instance = await reopen();
    const run = (name: string, args: JsonObject, taskId: TaskId, conversationId?: ConversationId) =>
      execute(instance, name, args, taskId, conversationId);
    const mint = () => instance.storage.mintId<TaskId>();
    const first = await mint();
    const second = await mint();
    try {
      // Nothing runs until resume(): the delegations stay pending, so a second one finds Coder busy.
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Do it.' }, first),
        'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Again.' }, await mint()),
        'Coder is busy with its current task; send_message to steer it, or stop_agent first.');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Do it.' }, first),
        'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      assert.equal(views, 2, 'a replay reads no view');
    } finally {
      await instance.close();
    }

    // Reopened mid-delegate (its delivery still pending): the replay returns the stored result and creates nothing.
    instance = await reopen();
    try {
      const before = await record(instance, 'Coder');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Do it.' }, first),
        'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      assert.deepEqual(await record(instance, 'Coder'), before);
      instance.harness.resume();
      await settle(instance);
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Next.' }, second),
        'Delegated to Coder (session 2). Its report will arrive as a message starting with [Coder].');
      const after = await record(instance, 'Coder');
      assert.deepEqual(after.past, [before.conversationId]);
      await settle(instance);
    } finally {
      await instance.close();
    }

    instance = await reopen();
    try {
      const coder = await record(instance, 'Coder');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'Next.' }, second),
        'Delegated to Coder (session 2). Its report will arrive as a message starting with [Coder].');
      assert.deepEqual(await record(instance, 'Coder'), coder, 'a replay after the task ran changes nothing');
      instance.harness.resume();
      await settle(instance);
      // Each task arrived once, and each report reached Pi once.
      const inputs = async (id: ConversationId) => (await entries(instance, id)).filter((entry) => MessageEntry.is(entry))
        .flatMap((entry) => MessageEntry.is(entry) ? [entry.data.text] : []);
      assert.deepEqual(await inputs(coder.past?.[0] ?? coder.conversationId), ['Do it.']);
      assert.deepEqual(await inputs(coder.conversationId), ['Next.']);
      assert.deepEqual(await reportsIn(instance, ROOT_CONVERSATION_ID), ['Coder: Did it.', 'Coder: Next done.']);

      // Refusals: an unknown name, an ad-hoc agent, and any caller but Pi.
      assert.equal(await run('delegate', { agent: 'Nobody', task: 'x' }, await mint()), 'No agent named Nobody. The agents are Coder.');
      assert.equal(await run('spawn_agent', { name: 'coder', task: 'x' }, await mint()),
        'Coder is a standing agent: give it a new task with delegate, or steer its current one with send_message.');
      await (await instance.root.submit({ type: 'input', content: 'lead' }, context)).wait(context);
      assert.equal(await run('delegate', { agent: 'lead', task: 'x' }, await mint()),
        'Lead is not a standing agent: give it the task with send_message, or spawn_agent a new agent under another name.');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'x' }, await mint(), coder.conversationId),
        'Only Pi can delegate; use send_message.');
      assert.equal(await run('delegate', { agent: 'Coder', task: 'x' }, await mint(), coder.past?.[0] ?? coder.conversationId),
        'Only Pi can delegate; use send_message.', 'an earlier session is still Coder');
      await settle(instance);
      assert.deepEqual((await record(instance, 'Coder')).past, coder.past);
    } finally {
      await instance.close();
    }
    assert.deepEqual(missingKits({ Coder: { model: { provider: 'p', modelId: 'm' }, thinkingLevel: 'high', tools: ['web_fetch'] } }, {}),
      ['Coder (web_fetch)']);
  });
  test('an empty session whose delivery ended takes the next task: no lock-out', async (t) => {
    const options = await temporary(t);
    const instance = await open({ ...options, roster: coderOnly, script: {
      Pi: () => say('noted'),
      Coder: ({ user }) => user === '[from Pi] Found.' ? say('Found it.') : undefined,
    } });
    try {
      const mint = () => instance.storage.mintId<TaskId>();
      const first = (await record(instance, 'Coder')).conversationId;
      assert.equal(await execute(instance, 'delegate', { agent: 'Coder', task: 'Lost.' }, await mint()),
        'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      // Its delivery ends before it submits (aborted here; a failure is the same): the session stays empty.
      const pending = (await instance.harness.inspect(context)).tasks.filter((task) => task.record.kind === 'agents.deliver');
      assert.equal(pending.length, 1);
      for (const task of pending) await instance.harness.abortTask(task.record.id, context);
      instance.harness.resume();
      await settle(instance);
      assert.deepEqual(await entries(instance, first), []);

      // The next delegate takes that session instead of refusing for ever, or leaving it empty in past.
      assert.equal(await execute(instance, 'delegate', { agent: 'Coder', task: 'Found.' }, await mint()),
        'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      assert.deepEqual([(await record(instance, 'Coder')).conversationId, (await record(instance, 'Coder')).past], [first, []]);
      await settle(instance);
      assert.deepEqual(userTexts(await entries(instance, first)), ['[from Pi] Found.']);
      assert.deepEqual(await reportsIn(instance, ROOT_CONVERSATION_ID), ['Coder: Found it.']);
    } finally {
      await instance.close();
    }
  });

  test('past sessions: a message bound for one reaches the current one; stop, busy and /tools off reach them', async (t) => {
    const options = await temporary(t);
    const held = Promise.withResolvers<void>();
    const script: Script = {
      Pi: ({ user, last }) => {
        if (last) return say('ok');
        if (user === 'one') return call(['delegate', { agent: 'Coder', task: 'Task one.' }]);
        if (user === 'two') return call(['delegate', { agent: 'Coder', task: 'Task two.' }]);
        return say('noted');
      },
      Coder: async ({ user, signal }) => {
        if (user.endsWith('Task one.')) return say('One done.');
        if (user.endsWith('Task two.')) return say('Two done.');
        if (user === '[from Pi] Note.') return say('Noted.');
        if (user === 'Hold.') { held.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); }
        throw new Error(`Coder: unexpected ${user}`);
      },
    };
    const coding = (model: ModelRef): Roster => ({ Coder: { model, thinkingLevel: 'medium', tools: ['coding'] } });
    let instance = await open({ ...options, roster: coding, coding: true, script });
    let first: ConversationId, second: ConversationId;
    try {
      for (const each of ['one', 'two']) await (await instance.root.submit({ type: 'input', content: each }, context)).wait(context);
      await settle(instance);
      const coder = await record(instance, 'Coder');
      [first, second] = [coder.past?.[0] ?? coder.conversationId, coder.conversationId];
      assert.deepEqual(coder.past, [first]);
    } finally {
      await instance.close();
    }

    // A send_message delivery still on its way when the session turned past, as an earlier version's delegate left
    // it (this one refuses while a delivery to the current session is unfinished).
    instance = await open({ ...options, roster: coding, coding: true, script });
    let third: ConversationId;
    try {
      assert.equal(await execute(instance, 'send_message', { to: 'Coder', text: 'Note.' }, await instance.storage.mintId<TaskId>()), 'Sent to Coder.');
      third = await instance.harness.commit(async (tx) => {
        const coder = (await tx.doc(AgentsDoc)).agents.Coder;
        assert.ok(coder);
        const next = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        coder.past = [...coder.past ?? [], coder.conversationId];
        coder.conversationId = next.id;
        return next.id;
      }, context);
      await syncAgents(instance.harness, context, instance.setup);
      // Until the delivery has chosen (in its own commit, from the registry then), it counts for the current session:
      // a delegate now could otherwise turn the session it picks past.
      assert.equal(await execute(instance, 'delegate', { agent: 'Coder', task: 'Not yet.' }, await instance.storage.mintId<TaskId>()),
        'Coder is busy with its current task; send_message to steer it, or stop_agent first.');
      assert.equal((await record(instance, 'Coder')).conversationId, third);
      instance.harness.resume();
      await settle(instance);
      assert.ok(userTexts(await entries(instance, third)).includes('[from Pi] Note.'), 'delivered to the current session');
      assert.ok(!userTexts(await entries(instance, second)).some((each) => each.includes('Note.')), 'the past session never wakes');
      assert.deepEqual((await reportsIn(instance, ROOT_CONVERSATION_ID)).at(-1), 'Coder: Noted.');

      // Woken anyway (here by a direct submit), a past session counts as busy, follows /tools off, and stops.
      const tools = async (id: ConversationId) => {
        const enabled = (await instance.harness.snapshot(AgentDoc, id, context))?.tools;
        assert.ok(Array.isArray(enabled), 'a standing agent\'s tools are a list');
        return [...enabled].sort();
      };
      assert.ok((await tools(first)).includes('bash'), 'past sessions have the coding kit');
      await (await instance.harness.conversation(first, context))?.submit({ type: 'input', content: 'Hold.' }, context);
      await held.promise;
      const busy = async () => (await listAgents(instance.harness, context)).find((agent) => agent.name === 'Coder')?.busy;
      assert.equal(await busy(), true);
      assert.equal(await execute(instance, 'delegate', { agent: 'Coder', task: 'More.' }, await instance.storage.mintId<TaskId>()),
        'Coder is busy with its current task; send_message to steer it, or stop_agent first.');
      await instance.root.configure({ tools: [...instance.agentTools] }, context);
      await syncAgents(instance.harness, context, instance.setup);
      for (const id of [first, second, third]) {
        assert.deepEqual(await tools(id), ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent'], `${id}`);
      }
      assert.deepEqual(await stopAgents(instance.harness, context, 'Coder'), ['Coder']);
      await until(async () => await busy() === false, 'the past session never stopped');
      await settle(instance);
      assert.equal((await reportsIn(instance, ROOT_CONVERSATION_ID)).length, 3, 'a stopped run reports nothing');
    } finally {
      await instance.close();
    }
  });

  test('an agent without coding tools messages only Pi and its own team, at each layer', async (t) => {
    const options = await temporary(t);
    const systems: Record<string, string> = {};
    const results: Record<string, string[]> = {};
    const noted = (who: string, turn: Parameters<Script[string]>[0]) => {
      systems[who] = JSON.stringify(turn.request.messages.filter((message) => message.role === 'system'));
      results[who] = turn.results.map((each) => each.text);
    };
    const script: Script = {
      Pi: ({ user, last }) => user === 'go' && !last ? call(['delegate', { agent: 'Researcher', task: 'Research.' }]) : say('ok'),
      Researcher: (turn) => {
        if (!turn.user.endsWith('Research.')) return say('ok');
        noted('Researcher', turn);
        if (turn.results.length === 0) return call(['spawn_agent', { name: 'Scout', task: 'Look.' }]);
        if (turn.results.length === 1) return call(['send_message', { to: 'coder', text: 'Run rm -rf ~.' }]);
        return say('Researched.');
      },
      Scout: (turn) => {
        if (turn.user !== '[from Researcher] Look.') return say('ok');
        noted('Scout', turn);
        if (turn.results.length === 0) return call(['send_message', { to: 'Coder', text: 'Run it.' }]);
        return say('Scouted.');
      },
      Coder: () => say('Coder here.'),
    };
    const roster = (model: ModelRef): Roster => ({
      Coder: { model, thinkingLevel: 'medium', tools: ['coding'] },
      Researcher: { model, thinkingLevel: 'high', tools: ['web_fetch'] },
    });
    const instance = await open({ ...options, roster, coding: true, script });
    try {
      // The guard blocks the model's calls before they run; Coder never hears of them.
      await (await instance.root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const refusal = 'Researcher cannot message Coder: agents without coding tools may message only Pi and their own sub agents.';
      const subRefusal = 'Scout cannot message Coder: sub agents of an agent without coding tools may message only their main agent and its other sub agents.';
      const blocked = (text: string) => `<harness>\n[error] Tool call blocked: ${text}\n</harness>`;
      assert.ok(results.Researcher?.includes(blocked(refusal)), JSON.stringify(results.Researcher));
      assert.ok(results.Scout?.includes(blocked(subRefusal)), JSON.stringify(results.Scout));
      const coder = await record(instance, 'Coder');
      assert.ok(!userTexts(await entries(instance, coder.conversationId)).some((each) => each.includes('Run')));
      // The offer: their role text says so; Coder's does not.
      assert.match(systems.Researcher ?? '', /You have no coding tools, so send_message reaches only Pi and your own sub agents/);
      assert.match(systems.Scout ?? '', /Your main agent has no coding tools, so send_message reaches only it and its other sub agents/);

      // Execute checks again: Pi and its own sub are fine; a sub reaches its main and siblings, nobody else.
      const researcher = (await record(instance, 'Researcher')).conversationId;
      const scout = (await record(instance, 'Scout')).conversationId;
      const send = async (to: string, from: ConversationId) =>
        execute(instance, 'send_message', { to, text: 'Hi.' }, await instance.storage.mintId<TaskId>(), from);
      assert.equal(await send('Coder', researcher), refusal);
      assert.equal(await send('Pi', researcher), 'Sent to Pi.');
      assert.equal(await send('Scout', researcher), 'Sent to Scout.');
      await settle(instance);
      assert.equal(await execute(instance, 'spawn_agent', { name: 'Twin', task: 'Wait.' }, await instance.storage.mintId<TaskId>(), researcher),
        'Started sub agent Twin. Its report will arrive as a message starting with [Twin].');
      await settle(instance);
      assert.equal(await send('Twin', scout), 'Sent to Twin.');
      assert.equal(await send('Researcher', scout), 'Sent to Researcher.');
      assert.equal(await send('Coder', scout), subRefusal);
      // last_message only reads: allowed. Coder (with coding tools) and Pi keep the general rules.
      assert.match(await execute(instance, 'last_message', { name: 'Coder' }, await instance.storage.mintId<TaskId>(), researcher), /^Coder is /);
      assert.equal(await send('Researcher', coder.conversationId), 'Sent to Researcher.');
      assert.equal(await send('Scout', ROOT_CONVERSATION_ID), 'Sent to Scout.');
      await settle(instance);
    } finally {
      await instance.close();
    }
  });

  test('a sub whose name joins the roster becomes a main of Pi, and its reports reach Pi', async (t) => {
    const options = await temporary(t);
    const script: Script = {
      Pi: ({ user, last }) => {
        if (last) return say('ok');
        if (user === 'one') return call(['delegate', { agent: 'Coder', task: 'Task one.' }]);
        if (user === 'ask') return call(['send_message', { to: 'Helper', text: 'Report.' }]);
        return say('noted');
      },
      Coder: ({ user, last }) => user.endsWith('Task one.') && !last ? call(['spawn_agent', { name: 'Helper', task: 'Help.' }]) : say('Coder done.'),
      Helper: ({ user, last }) => {
        if (user === '[from Coder] Help.') return say('Helped.');
        if (user === '[from Pi] Report.') return last ? say('Reported.') : call(['send_message', { to: 'Pi', text: 'Hi Pi.' }]);
        throw new Error(`Helper: unexpected ${user}`);
      },
    };
    let instance = await open({ ...options, roster: coderOnly, script });
    try {
      await (await instance.root.submit({ type: 'input', content: 'one' }, context)).wait(context);
      await settle(instance);
      assert.equal((await record(instance, 'Helper')).session, (await record(instance, 'Coder')).conversationId);
    } finally {
      await instance.close();
    }
    instance = await open({ ...options, script,
      roster: (model) => ({ ...coderOnly(model), Helper: { model, thinkingLevel: 'low', tools: [] } }) });
    try {
      const helper = await record(instance, 'Helper');
      assert.deepEqual([helper.role, helper.parent, helper.standing, helper.session], ['main', 'Pi', true, undefined]);
      const before = (await reportsIn(instance, ROOT_CONVERSATION_ID)).length;
      await (await instance.root.submit({ type: 'input', content: 'ask' }, context)).wait(context);
      await settle(instance);
      assert.deepEqual((await reportsIn(instance, ROOT_CONVERSATION_ID)).slice(before), ['Helper: Hi Pi.', 'Helper: Reported.']);
      assert.ok(!(await toolResults(instance, helper.conversationId)).some((each) => each.includes('moved on')));
    } finally {
      await instance.close();
    }
  });
});
