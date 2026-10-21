import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import {
  type ConversationId, createRegistry, type Cursor, defineEntry, type EntryRecord, type JsonObject, LiveDoc, type ModelRef,
  ROOT_CONVERSATION_ID, type Session, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx,
} from '@earendil-works/pi-durable';
import {
  ARCHIVE_TTL_MS, AgentsDoc, type AgentsStopper, agentTranscript, archiveAgents, createAgentsExtension, listAgents, purgeArchived, REPORT_KIND,
  restoreAgent, type Roster, syncAgents,
} from '../../src/agents/index.ts';
import { type AgentsInstance, call, openAgents, router, say, type Script } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

// Archiving ad-hoc agents, and deleting them a day later (ADR 0034).

const ReportEntry = defineEntry<{ name: string; text: string }>(REPORT_KIND);
const T0 = Date.UTC(2026, 9, 21, 12);
const deletedAt = new Date(T0 + ARCHIVE_TTL_MS).toISOString();

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-archive-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'archive.sqlite') };
}

/** Pi spawns Lead on "spawn"; Lead spawns Sub, then reports; Sub reports; anything else is answered "ok". */
const SPAWNING: Script = {
  Pi: ({ user, last }) => {
    if (last) return say('ok');
    const spawn = /^spawn (\w+)$/.exec(user);
    return spawn?.[1] ? call(['spawn_agent', { name: spawn[1], task: 'Plan.' }]) : say('ok');
  },
  Lead: ({ user, last }) => user.endsWith('Plan.') && !last ? call(['spawn_agent', { name: 'Sub', task: 'Part.' }]) : say('Lead done.'),
  Sub: () => say('Sub done.'),
};

async function open(options: { databasePath: string; cwd: string }, script: Script = SPAWNING, roster?: (model: ModelRef) => Roster) {
  const { models, model } = offlineModels(router(script));
  const hooks = roster ? { roster: roster(model) } : {};
  const instance = await openAgents({ ...options, models, model, hooks });
  if (roster) await syncAgents(instance.harness, instance.context, hooks);
  return instance;
}

async function settle({ harness, context }: AgentsInstance, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}
const ask = async (instance: AgentsInstance, content: string) => {
  await (await instance.root.submit({ type: 'input', content }, instance.context)).wait(instance.context);
  await settle(instance);
};

async function entries({ harness, context }: AgentsInstance, conversationId: ConversationId) {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}
const reportsToPi = async (instance: AgentsInstance) => (await entries(instance, ROOT_CONVERSATION_ID))
  .flatMap((entry) => ReportEntry.is(entry) ? [`${entry.data.name}: ${entry.data.text}`] : []);
const registryOf = async ({ harness, context }: AgentsInstance) => (await harness.snapshot(AgentsDoc, context))?.agents ?? {};
const idOf = async (instance: AgentsInstance, name: string) => {
  const agent = (await registryOf(instance))[name];
  assert.ok(agent, `no agent ${name}`);
  return agent.conversationId;
};
const visible = async ({ harness, context }: AgentsInstance) => (await listAgents(harness, context)).map((agent) => agent.name).sort();

/**
 * Run one of the agents' tools directly, as a fresh tool call of `conversationId`; its text result. `archive` names agents
 * archived in the tool's own commit, so the deliveries it creates meet them archived.
 */
async function execute(instance: AgentsInstance, name: string, args: JsonObject, conversationId: ConversationId = ROOT_CONVERSATION_ID,
  archive: readonly string[] = []) {
  const tool = Object.fromEntries(createAgentsExtension().tools.map((each): [string, ToolRegistration] => [each.name, each]))[name];
  assert.ok(tool, `no tool ${name}`);
  const { harness, context } = instance;
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
    taskId: await instance.storage.mintId<TaskId>(), conversationId, callId: 'direct', registry: createRegistry().snapshot(),
    models: offlineModels().models, env: undefined, outputWindow: undefined,
    snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness), watchDoc: harness.watchDoc.bind(harness),
    commit: <T>(change: (tx: Tx) => T | Promise<T>, at: typeof context) => harness.commit(async (tx) => {
      const result = await change(owned(tx));
      const registry = await tx.doc(AgentsDoc);
      for (const each of archive) { const agent = registry.agents[each]; if (agent) agent.archivedAt = T0; }
      return result;
    }, at),
    conversation: harness.conversation.bind(harness),
    agent: unused, output: unused, retainedOutput: unused, diagnostic: unused, details: unused, memo: unused,
    createTask: unused, getTask: unused, waitForTask: unused, executeTool: unused,
  };
  const block = (await tool.execute(args, api, context)).output?.[0];
  assert.ok(block?.type === 'text');
  return block.text;
}

describe('archived agents (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('archiving a main archives its sub; nothing reaches them; zoom reads them; restore brings them back', async (t) => {
    const instance = await open(await temporary(t));
    const { harness, context } = instance;
    try {
      await ask(instance, 'spawn Lead');
      await ask(instance, 'spawn Other');
      assert.deepEqual(await visible(instance), ['Lead', 'Other', 'Sub']);

      assert.deepEqual(await archiveAgents(harness, context, { name: 'lead' }, T0), ['Lead', 'Sub']);
      assert.deepEqual(await visible(instance), ['Other']);
      const all = await listAgents(harness, context, { includeArchived: true });
      assert.deepEqual(all.map((agent) => [agent.name, agent.archivedAt]).sort(), [['Lead', T0], ['Other', undefined], ['Sub', T0]]);
      assert.ok(!('archivedAt' in (all.find((agent) => agent.name === 'Other') ?? {})), 'absent, not undefined');

      // Archiving again keeps the first time.
      assert.deepEqual(await archiveAgents(harness, context, { name: 'Lead' }, T0 + 5), ['Lead', 'Sub']);
      assert.equal((await registryOf(instance)).Lead?.archivedAt, T0);

      // Every tool refuses them, names them nowhere, and says when they go.
      const refusal = (name: string) => `${name} is archived; it is deleted at ${deletedAt}.`;
      assert.equal(await execute(instance, 'send_message', { to: 'Lead', text: 'Hi.' }), refusal('Lead'));
      assert.equal(await execute(instance, 'send_message', { to: 'sub', text: 'Hi.' }), refusal('Sub'));
      assert.equal(await execute(instance, 'last_message', { name: 'Lead' }), refusal('Lead'));
      assert.equal(await execute(instance, 'stop_agent', { name: 'Sub' }), refusal('Sub'));
      assert.equal(await execute(instance, 'spawn_agent', { name: 'LEAD', task: 'Again.' }), refusal('Lead'));
      const listed = await execute(instance, 'list_agents', {}, await idOf(instance, 'Other'));
      assert.ok(listed.includes('- Pi (session agent)') && !listed.includes('Lead') && !listed.includes('Sub'), listed);

      // zoom still reads an archived agent.
      assert.match(await agentTranscript(harness, 'Lead', context), /0\|user: \[from Pi\] Plan\./);

      // Restoring a sub of an archived main is refused; restoring the main restores both.
      await assert.rejects(restoreAgent(harness, context, 'Sub'), { message: 'Sub\'s main agent Lead is archived; restore Lead.' });
      assert.deepEqual(await restoreAgent(harness, context, 'lead'), ['Lead', 'Sub']);
      await assert.rejects(restoreAgent(harness, context, 'Lead'), { message: 'Lead is not archived.' });
      await assert.rejects(restoreAgent(harness, context, 'Nobody'), { message: 'No agent named Nobody. The agents are Lead, Sub, Other.' });
      assert.deepEqual(await visible(instance), ['Lead', 'Other', 'Sub']);
      assert.equal(await execute(instance, 'send_message', { to: 'Lead', text: 'Hi.' }), 'Sent to Lead.');
      await settle(instance);

      // A sub may be archived alone; its main stays.
      assert.deepEqual(await archiveAgents(harness, context, { name: 'Sub' }, T0), ['Sub']);
      assert.deepEqual(await visible(instance), ['Lead', 'Other']);
      assert.equal(await execute(instance, 'send_message', { to: 'Sub', text: 'Hi.' }, await idOf(instance, 'Lead')), refusal('Sub'));
    } finally {
      await instance.close();
    }
  });

  test('{ adhoc: true } archives every ad-hoc main with its subs; standing and unknown agents are refused', async (t) => {
    const coder = (model: ModelRef): Roster => ({ Coder: { model, thinkingLevel: 'off', tools: [] } });
    const instance = await open(await temporary(t), SPAWNING, coder);
    const { harness, context } = instance;
    try {
      assert.deepEqual(await archiveAgents(harness, context, { adhoc: true }, T0), [], 'no ad-hoc agents yet');
      await ask(instance, 'spawn Lead');
      await ask(instance, 'spawn Other');
      await assert.rejects(archiveAgents(harness, context, { name: 'coder' }, T0),
        { message: 'Coder is a standing agent; remove it from the roster first.' });
      await assert.rejects(archiveAgents(harness, context, { name: 'Nobody' }, T0), { message: /^No agent named Nobody\. The agents are / });
      assert.deepEqual((await archiveAgents(harness, context, { adhoc: true }, T0)).sort(), ['Lead', 'Other', 'Sub']);
      assert.deepEqual(await visible(instance), ['Coder']);
      assert.deepEqual(await archiveAgents(harness, context, { adhoc: true }, T0 + 1), [], 'the archived ones are not archived again');
      assert.equal(await execute(instance, 'delegate', { agent: 'Coder', task: 'Work.' }), 'Delegated to Coder (session 1). Its report will arrive as a message starting with [Coder].');
      await settle(instance);
    } finally {
      await instance.close();
    }
  });

  test('archiving stops a running agent, which reports nothing; a crash before its commit leaves it only stopped', async (t) => {
    const started = Promise.withResolvers<void>();
    const instance = await open(await temporary(t), {
      ...SPAWNING,
      Lead: async ({ signal }) => {
        started.resolve();
        await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
        return say('Too late.');
      },
    });
    const { harness, context } = instance;
    try {
      await (await instance.root.submit({ type: 'input', content: 'spawn Lead' }, context)).wait(context);
      await started.promise;
      assert.deepEqual(await visible(instance), ['Lead']);
      // A crash at the archive's commit leaves Lead stopped but not archived; archiving again converges.
      let crashes = 1;
      const crashing: AgentsStopper & Pick<Session, 'commit'> = {
        snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness),
        conversation: harness.conversation.bind(harness),
        commit: (change, at) => crashes-- > 0 ? Promise.reject(new Error('crash')) : harness.commit(change, at),
      };
      await assert.rejects(archiveAgents(crashing, context, { name: 'Lead' }, T0), { message: 'crash' });
      await settle(instance);
      assert.equal((await harness.snapshot(LiveDoc, await idOf(instance, 'Lead'), context))?.run, undefined, 'stopped first');
      assert.deepEqual(await visible(instance), ['Lead'], 'not archived');
      assert.deepEqual(await archiveAgents(crashing, context, { name: 'Lead' }, T0), ['Lead']);
      assert.deepEqual(await visible(instance), []);
      await settle(instance);
      assert.equal((await harness.snapshot(LiveDoc, await idOf(instance, 'Lead'), context))?.run, undefined);
      assert.deepEqual(await reportsToPi(instance), []);
    } finally {
      await instance.close();
    }
  });

  test('deliveries to, and reports from, an archived agent complete without submitting', async (t) => {
    const instance = await open(await temporary(t));
    const { harness, context } = instance;
    try {
      await ask(instance, 'spawn Lead');
      const before = await reportsToPi(instance);
      const lead = await idOf(instance, 'Lead');
      const sub = await idOf(instance, 'Sub');
      const count = async (id: ConversationId) => (await entries(instance, id)).length;
      const [leadEntries, subEntries] = [await count(lead), await count(sub)];
      // Each delivery is created in the commit that archives its target or sender, so it runs with them archived.
      assert.equal(await execute(instance, 'send_message', { to: 'Lead', text: 'Late.' }, ROOT_CONVERSATION_ID, ['Lead']), 'Sent to Lead.');
      await settle(instance);
      assert.equal(await count(lead), leadEntries, 'nothing reached Lead');
      assert.deepEqual(await restoreAgent(harness, context, 'Lead'), ['Lead']);
      assert.equal(await execute(instance, 'send_message', { to: 'Pi', text: 'News.' }, lead, ['Lead']), 'Sent to Pi.');
      await settle(instance);
      assert.deepEqual(await reportsToPi(instance), before, 'Lead\'s message to Pi went nowhere');
      await restoreAgent(harness, context, 'Lead');
      assert.equal(await execute(instance, 'send_message', { to: 'Sub', text: 'Late.' }, lead, ['Sub']), 'Sent to Sub.');
      await settle(instance);
      assert.equal(await count(sub), subEntries, 'nothing reached Sub');
      // Restored, Lead hears again.
      await restoreAgent(harness, context, 'Sub');
      assert.equal(await execute(instance, 'send_message', { to: 'Lead', text: 'Back?' }), 'Sent to Lead.');
      await settle(instance);
      assert.ok(await count(lead) > leadEntries);
      assert.deepEqual(await reportsToPi(instance), [...before, 'Lead: Lead done.']);
    } finally {
      await instance.close();
    }
  });

  test('purge deletes agents archived for a day, subs with their main; zoom keeps their chat; the name is free', async (t) => {
    const instance = await open(await temporary(t));
    const { harness, context } = instance;
    try {
      await ask(instance, 'spawn Lead');
      await ask(instance, 'spawn Other');
      await archiveAgents(harness, context, { name: 'Lead' }, T0);
      await archiveAgents(harness, context, { name: 'Other' }, T0 + 1000);
      const old = await idOf(instance, 'Lead');
      assert.deepEqual(await purgeArchived(harness, context, T0 + ARCHIVE_TTL_MS - 1), []);
      assert.deepEqual(Object.keys(await registryOf(instance)).sort(), ['Lead', 'Other', 'Sub']);
      assert.deepEqual((await purgeArchived(harness, context, T0 + ARCHIVE_TTL_MS)).sort(), ['Lead', 'Sub']);
      assert.deepEqual(Object.keys(await registryOf(instance)), ['Other']);
      assert.deepEqual(await purgeArchived(harness, context, T0 + ARCHIVE_TTL_MS), [], 'a second sweep finds nothing');
      // As after delete_agent: zoom still reads the chat, and nothing else knows the name.
      assert.match(await agentTranscript(harness, 'Lead', context), /^Lead was deleted; its chat is kept\n/);
      assert.match(await execute(instance, 'send_message', { to: 'Lead', text: 'Hi.' }), /^No agent named Lead\. The agents are Other\.$/);
      // The name is free again: a new Lead, with a new conversation and a new sub.
      await ask(instance, 'spawn Lead');
      assert.deepEqual(await visible(instance), ['Lead', 'Sub']);
      assert.notEqual(await idOf(instance, 'Lead'), old);
      assert.equal((await agentTranscript(harness, 'Lead', context)).match(/\|user: \[from Pi\] Plan\./g)?.length, 1, 'only the new chat');
      assert.deepEqual(await purgeArchived(harness, context, T0 + 1000 + ARCHIVE_TTL_MS), ['Other']);
    } finally {
      await instance.close();
    }
  });
});
