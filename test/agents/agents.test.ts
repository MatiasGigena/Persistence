import assert from 'node:assert/strict';
import { fork, type Serializable } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import type { JsonValue } from '@earendil-works/chord';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import {
  AssistantEntry, type ConversationId, createRegistry, type Cursor, defineEntry, type Entry, type EntryRecord,
  type Harness, type JsonObject, LiveDoc, ROOT_CONVERSATION_ID, type TaskId, type ToolExecutionApi, type ToolExecutionResult,
  type ToolRegistration, ToolResultEntry, type TypedEntry, UserEntry,
} from '@earendil-works/pi-durable';
import {
  type AgentReport, AgentsDoc, agentTranscript, createAgentsExtension, listAgents, MESSAGE_KIND, REPORT_KIND, stopAgents, TRANSCRIPT_PAGE,
} from '../../src/agents/index.ts';
import { type AgentsInstance, call, openAgents, router, say, type Turn } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

// Placed input entries, as the agents extension writes them.
const MessageEntry = defineEntry<{ from: string; text: string }>(MESSAGE_KIND);
const ReportEntry = defineEntry<{ name: string; text: string; id: TaskId }>(REPORT_KIND);

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-agents-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'agents.sqlite') };
}

/** Test-only: wait until no task or submission is live anywhere. */
async function settle({ harness, context }: AgentsInstance, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}

async function entries(harness: Harness, conversationId: ConversationId, context: AgentsInstance['context']) {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

const agentId = async ({ harness, context }: AgentsInstance, name: string) => {
  const agent = (await harness.snapshot(AgentsDoc, context))?.agents[name];
  assert.ok(agent, `no agent ${name}`);
  return agent.conversationId;
};
const ofKind = <D extends JsonValue>(list: readonly EntryRecord[], kind: Entry<D>) =>
  list.filter((entry): entry is TypedEntry<D> => kind.is(entry));
const blocksText = (blocks: readonly { type: string; text?: string }[]) => blocks.map((block) => block.text ?? '').join('');
const userTexts = (list: readonly EntryRecord[]) => list.flatMap((entry) => (entry.model ?? []).filter((message) => message.role === 'user'))
  .map((message) => typeof message.content === 'string' ? message.content : blocksText(message.content));
const results = (list: readonly EntryRecord[]) => ofKind(list, ToolResultEntry).flatMap((entry) => entry.model ?? [])
  .filter((message) => message.role === 'toolResult');
const assistantText = (entry: EntryRecord) => (entry.model ?? []).flatMap((message) => message.role === 'assistant' ? [blocksText(message.content)] : []).join('');
/** The first output block's text; fails on anything else. */
const firstText = (content: readonly (TextContent | ImageContent)[] | undefined) => {
  const block = content?.[0];
  assert.ok(block?.type === 'text', `no text: ${JSON.stringify(content)}`);
  return block.text;
};
const startsWith = (content: readonly (TextContent | ImageContent)[], pattern: RegExp) =>
  content[0]?.type === 'text' && pattern.test(content[0].text);

describe('multi-agent messaging (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('Pi → main → two subs: list, message, last_message, reports, and role limits', async (t) => {
    const options = await temporary(t);
    const reports: AgentReport[] = [];
    const seen: Turn[] = [];
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'Start Lead.' && !last) return call(['spawn_agent', { name: 'Lead', task: 'Plan the work.' }]);
        if (last?.name === 'spawn_agent') return say('Lead started.');
        if (user.startsWith('[Lead]')) return say('Noted.');
      },
      Lead: ({ user, last, results: done }) => {
        if (user.includes('Plan the work.')) {
          if (!last) return call(['spawn_agent', { name: 'B', task: 'Do part B.' }]);
          if (done.length === 1) return call(['spawn_agent', { name: 'A', task: 'Do part A.' }]);
          return say('Delegated to A and B.');
        }
        if (user.startsWith('[A]')) {
          if (!last) return call(['last_message', { name: 'B' }], ['last_message', { name: 'Pi' }]);
          if (last.name === 'last_message') return call(['send_message', { to: 'Pi', text: 'A finished.' }]);
          return say('Lead saw A.');
        }
        // Unique per report, so a duplicate delivery would show as a repeated text.
        if (user.startsWith('[B]')) return say(`Lead saw ${user}`);
      },
      A: ({ user, last, results: done }) => {
        if (!user.includes('Do part A.')) return undefined;
        if (!last) return call(['list_agents', {}]);
        if (last.name === 'list_agents') {
          return call(['send_message', { to: 'Pi', text: 'hi Pi' }], ['spawn_agent', { name: 'C', task: 'x' }],
            ['last_message', { name: 'Pi' }]);
        }
        if (done.length === 4) return call(['send_message', { to: 'B', text: 'hello from A' }]);
        return say('A done.');
      },
      B: ({ user }) => user.includes('hello from A') ? say('B got hello.') : say('B done.'),
    }, seen));
    const instance = await openAgents({ ...options, ...catalog,
      hooks: { onReport: (report) => reports.push(report),
        initialContext: ({ name, role, parent }) => `<view>context for ${name} (${role} of ${parent})</view>` } });
    try {
      const { harness, root, context } = instance;
      const submission = await root.submit({ type: 'input', content: 'Start Lead.' }, context);
      assert.equal((await submission.wait(context)).status, 'done');
      await settle(instance);

      // Registry and per-role tool offers.
      const listed = await listAgents(harness, context);
      const agent = (name: string) => {
        const found = listed.find((each) => each.name === name);
        assert.ok(found, `no agent ${name}`);
        return found;
      };
      const agents = { Lead: agent('Lead'), A: agent('A'), B: agent('B') };
      assert.deepEqual(listed.map((each) => each.name).sort(), ['A', 'B', 'Lead']);
      assert.deepEqual([agents.Lead.role, agents.Lead.parent], ['main', 'Pi']);
      assert.deepEqual([agents.A.role, agents.A.parent, agents.B.role, agents.B.parent], ['sub', 'Lead', 'sub', 'Lead']);
      const choices = async (name: keyof typeof agents) => {
        const conversation = await harness.conversation(agents[name].conversationId, context);
        assert.ok(conversation, `no conversation for ${name}`);
        return conversation.agent(context);
      };
      const offered = async (name: keyof typeof agents) => (await choices(name)).tools.map((tool) => tool.name).sort();
      assert.deepEqual(await offered('Lead'), ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent']);
      assert.deepEqual(await offered('A'), ['last_message', 'list_agents', 'send_message']);
      assert.equal((await root.agent(context)).model?.modelId, (await choices('A')).model?.modelId);

      // First inputs: preamble from initialContext, then the task from the spawner.
      const lead = await entries(harness, agents.Lead.conversationId, context);
      assert.equal(userTexts(ofKind(lead, MessageEntry))[0], '<view>context for Lead (main of Pi)</view>\n\n[from Pi] Plan the work.');
      const a = await entries(harness, agents.A.conversationId, context);
      assert.deepEqual(ofKind(a, MessageEntry).map((entry) => entry.data), [{ from: 'Lead', text: 'Do part A.' }]);

      // A sub lists all other agents, but not Pi.
      const byCall = Object.fromEntries(ofKind(a, AssistantEntry).flatMap((entry) => entry.model ?? [])
        .flatMap((message) => message.role === 'assistant' ? message.content : []).filter((block) => block.type === 'toolCall')
        .map((block): [string, string] => [`${block.name}:${JSON.stringify(block.arguments)}`, block.id]));
      const resultOf = (name: string, args: JsonObject) => results(a).find((result) => result.toolCallId === byCall[`${name}:${JSON.stringify(args)}`]);
      const list = resultOf('list_agents', {});
      const toPi = resultOf('send_message', { to: 'Pi', text: 'hi Pi' });
      const spawn = resultOf('spawn_agent', { name: 'C', task: 'x' });
      const lastPi = resultOf('last_message', { name: 'Pi' });
      const toB = resultOf('send_message', { to: 'B', text: 'hello from A' });
      assert.match(firstText(list?.content), /- Lead \(main, parent Pi\) (busy|idle)/);
      assert.match(firstText(list?.content), /- B \(sub, parent Lead\) (busy|idle)/);
      assert.doesNotMatch(firstText(list?.content), /Pi \(session/);
      // A sub can neither address Pi nor spawn.
      assert.equal(toPi?.isError, true);
      assert.match(JSON.stringify(toPi?.content), /cannot address Pi/);
      assert.equal(spawn?.isError, true);
      assert.equal(lastPi?.isError, true);
      assert.match(JSON.stringify(lastPi?.content), /cannot address Pi/);
      assert.equal(firstText(toB?.content), 'Sent to B.');

      // The sub-to-sub message reached B and started (or steered) a run that answered it.
      const b = await entries(harness, agents.B.conversationId, context);
      assert.deepEqual(ofKind(b, MessageEntry).map((entry) => entry.data.from), ['Lead', 'A']);
      assert.ok(userTexts(b).includes('[from A] hello from A'));
      assert.ok(seen.some((turn) => turn.who === 'B' && turn.user === '[from A] hello from A'));

      // Sub reports reached Lead; last_message works for a sub and for Pi.
      const reportsToLead = ofKind(await entries(harness, agents.Lead.conversationId, context), ReportEntry);
      assert.ok(reportsToLead.some((entry) => entry.data.name === 'A' && entry.data.text === 'A done.'));
      assert.ok(reportsToLead.some((entry) => entry.data.name === 'B'));
      const leadResults = results(await entries(harness, agents.Lead.conversationId, context));
      const lastB = leadResults.find((result) => result.toolName === 'last_message' && startsWith(result.content, /^B is/));
      assert.match(firstText(lastB?.content), /^B is (busy|idle)\. Last message:\nB (done|got hello)\./);
      assert.match(firstText(leadResults.find((result) => startsWith(result.content, /^Pi is/))?.content),
        /^Pi is (busy|idle)\. Last message:\n(Lead started\.|Noted\.)/);

      // Main → Pi messages and final reports reach Pi as agents.report entries, each once.
      const rootReports = ofKind(await entries(harness, ROOT_CONVERSATION_ID, context), ReportEntry);
      const texts = rootReports.map((entry) => entry.data.text);
      assert.ok(rootReports.every((entry) => entry.data.name === 'Lead'));
      assert.equal(new Set(texts).size, texts.length, `duplicate report: ${texts.join(',')}`);
      assert.ok(texts.includes('Delegated to A and B.'));
      assert.ok(texts.includes('A finished.'));
      // Inputs to Pi take upstream's report format; inputs to agents stay `[Name] text`.
      assert.ok(userTexts(rootReports).includes('[Lead]\nDelegated to A and B.\n\nFull chat: zoom("Lead")'));
      assert.ok(userTexts(rootReports).includes('[Lead]\nA finished.\n\nFull chat: zoom("Lead")'));
      assert.ok(userTexts(reportsToLead).includes('[A] A done.'));
      assert.deepEqual(reports.map((report) => report.text).sort(), [...texts].sort());
      assert.ok(reports.every((report) => report.name === 'Lead'));
      assert.ok(seen.some((turn) => turn.who === 'Pi' && turn.user === '[Lead]\nA finished.\n\nFull chat: zoom("Lead")'));

      // Transcript rendering for zoom(): upstream's `i|kind: text` lines, inputs from their entries, no view preamble.
      const zoom = await agentTranscript(harness, 'B', context);
      assert.match(zoom, /^0\|note: the first message also held Pi's view at the spawn \(not shown\)\n\n1\|user: \[from Lead\] Do part B\.\n\n/);
      assert.match(zoom, /\n\n\d+\|user: \[from A\] hello from A\n\n\d+\|B: B got hello\./);
      assert.doesNotMatch(zoom, /<view>/);
      const leadChat = await agentTranscript(harness, 'Lead', context);
      assert.match(leadChat, /\d+\|tool: spawn_agent\(\{"name":"B","task":"Do part B\."\}\)\n\n\d+\|echo: spawn_agent: Started sub agent B\./);
      assert.match(leadChat, /\d+\|user: \[A\] A done\./);
      assert.match(await agentTranscript(harness, 'Pi', context), /\d+\|tool: spawn_agent\(\{"name":"Lead"/);
    } finally {
      await instance.close();
    }
  });

  test('execute refuses Pi-addressing and spawning for sub agents too', async (t) => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ last }) => last ? say('ok') : call(['spawn_agent', { name: 'M', task: 'spawn S' }]),
      M: ({ last }) => last ? say('done') : call(['spawn_agent', { name: 'S', task: 'idle' }]),
      S: () => say('idle'),
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const tools = Object.fromEntries(createAgentsExtension().tools.map((tool): [string, ToolRegistration] => [tool.name, tool]));
      // A tool api backed by the Harness: only reads, commits, and IDs are used by these calls.
      const unused = (): never => { throw new Error('not used by the agents tools'); };
      const api: ToolExecutionApi = {
        taskId: await instance.storage.mintId<TaskId>(), conversationId: await agentId(instance, 'S'), callId: 'direct',
        registry: createRegistry().snapshot(), models: catalog.models, env: undefined, outputWindow: undefined,
        snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness),
        watchDoc: harness.watchDoc.bind(harness), commit: harness.commit.bind(harness),
        agent: unused, output: unused, retainedOutput: unused, diagnostic: unused, details: unused, memo: unused,
        createTask: unused, getTask: unused, waitForTask: unused, conversation: unused, executeTool: unused,
      };
      const text = (result: ToolExecutionResult) => firstText(result.output);
      const execute = async (name: string, args: JsonObject, conversationId = api.conversationId) => {
        const tool = tools[name];
        assert.ok(tool, `no tool ${name}`);
        return text(await tool.execute(args, { ...api, conversationId, taskId: await instance.storage.mintId<TaskId>() }, context));
      };
      const run = (name: string, args: JsonObject) => execute(name, args);
      assert.match(await run('send_message', { to: 'Pi', text: 'x' }), /cannot address Pi/);
      assert.match(await run('send_message', { to: 'pi', text: 'x' }), /cannot address Pi/);
      assert.match(await run('last_message', { name: 'Pi' }), /cannot address Pi/);
      assert.match(await run('spawn_agent', { name: 'X', task: 'x' }), /cannot spawn/);
      assert.match(await run('stop_agent', { name: 'M' }), /cannot stop/);
      assert.match(await run('send_message', { to: 'S', text: 'x' }), /yourself/);
      assert.match(await execute('spawn_agent', { name: 'M', task: 'x' }, ROOT_CONVERSATION_ID), /already exists/);
      assert.match(await execute('spawn_agent', { name: 'bad name', task: 'x' }, ROOT_CONVERSATION_ID), /Invalid name/);
      assert.match(await execute('spawn_agent', { name: 'pi', task: 'x' }, ROOT_CONVERSATION_ID), /Invalid name/);
      // zoom() reads an id of digits as a message id, so a name starts with a letter.
      assert.match(await execute('spawn_agent', { name: '42', task: 'x' }, ROOT_CONVERSATION_ID), /Invalid name/);
      assert.match(await execute('spawn_agent', { name: '_x', task: 'x' }, ROOT_CONVERSATION_ID), /Invalid name/);
      assert.deepEqual(Object.keys((await harness.snapshot(AgentsDoc, context))?.agents ?? {}).sort(), ['M', 'S']);
    } finally {
      await instance.close();
    }
  });

  test('stopping a main also stops its busy sub; a stopped run reports nothing', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'go') return last ? say('spawned') : call(['spawn_agent', { name: 'Lead', task: 'delegate' }]);
        if (user.startsWith('[Lead]')) return say('noted');
        if (user === 'stop Lead') return last ? say('stopped') : call(['stop_agent', { name: 'Lead' }]);
        if (user === 'stop S') return last ? say('stopped S') : call(['stop_agent', { name: 'S' }]);
      },
      Lead: ({ last }) => last ? say('S is on it') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
      S: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      const ask = async (content: string) => (await root.submit({ type: 'input', content }, context)).wait(context);
      await ask('go');
      await started.promise;
      // Lead's report has reached Pi and Pi is idle again; only S still works.
      for (const until = Date.now() + 15_000; ; await delay(10)) {
        const reported = ofKind(await entries(harness, ROOT_CONVERSATION_ID, context), ReportEntry).length === 1;
        const busy = (await listAgents(harness, context)).filter((agent) => agent.busy).map((agent) => agent.name);
        const piIdle = (await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run === undefined;
        if (reported && busy.join() === 'S' && piIdle) break;
        assert.ok(Date.now() < until, 'Lead never reported');
      }
      await ask('stop Lead');
      await settle(instance);
      const piResults = results(await entries(harness, ROOT_CONVERSATION_ID, context)).map((result) => firstText(result.content));
      assert.ok(piResults.includes('Stopped Lead and its sub agents S.'), piResults.join(' | '));
      assert.deepEqual((await listAgents(harness, context)).filter((agent) => agent.busy), []);
      assert.deepEqual(ofKind(await entries(harness, await agentId(instance, 'S'), context), AssistantEntry), []);
      assert.deepEqual(ofKind(await entries(harness, await agentId(instance, 'Lead'), context), ReportEntry), []);
      assert.deepEqual(ofKind(await entries(harness, ROOT_CONVERSATION_ID, context), ReportEntry).map((entry) => entry.data.text), ['S is on it']);
      // Pi stopping a sub is told that the sub's main agent does not know.
      await ask('stop S');
      const last = results(await entries(harness, ROOT_CONVERSATION_ID, context)).at(-1);
      assert.equal(firstText(last?.content), 'Stopped S. Its main agent Lead is not told; message it if it should know.');
    } finally {
      await instance.close();
    }
  });

  test('stopAgents() stops every agent, subs first, for a host-wide stop; Pi is untouched', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => user === 'go' ? (last ? say('spawned') : call(['spawn_agent', { name: 'Lead', task: 'delegate' }])) : say('noted'),
      Lead: ({ last }) => last ? say('S is on it') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
      S: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await started.promise;
      assert.deepEqual(await stopAgents(harness, context, 'nobody'), []);
      assert.deepEqual(await stopAgents(harness, context), ['S', 'Lead']);
      await settle(instance);
      assert.deepEqual((await listAgents(harness, context)).filter((agent) => agent.busy), []);
      assert.deepEqual(ofKind(await entries(harness, await agentId(instance, 'S'), context), AssistantEntry), []);
    } finally {
      await instance.close();
    }
  });

  test('a failed run reports why, and an empty reply reports "(no reply)"', async (t) => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'go') return last ? say('spawned') : call(['spawn_agent', { name: 'E', task: 'say nothing' }], ['spawn_agent', { name: 'F', task: 'fail' }]);
        if (user.startsWith('[E]') || user.startsWith('[F]')) return say('noted');
      },
      E: () => say(''),
      F: () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'the model broke' }),
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const reports = Object.fromEntries(ofKind(await entries(harness, ROOT_CONVERSATION_ID, context), ReportEntry)
        .map((entry) => [entry.data.name, entry.data.text]));
      assert.equal(reports.E, '(no reply)');
      assert.match(reports.F ?? '', /^failed: \w+: the model broke$/);
    } finally {
      await instance.close();
    }
  });

  test('zoom("Name") pages a long chat at line ends, 30,000 characters at most', async (t) => {
    const options = await temporary(t);
    const long = Array.from({ length: 1_500 }, (_, i) => `line ${i} ${'.'.repeat(40)}`).join('\n');
    const catalog = offlineModels(router({
      Pi: ({ last }) => last ? say('spawned') : call(['spawn_agent', { name: 'Long', task: long }]),
      Long: () => say('ok'),
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const whole = await agentTranscript(harness, 'Long', context);
      assert.ok(whole.length > 60_000 && whole.length < 90_000, String(whole.length));
      const pages = [1, 2, 3].map((page) => agentTranscript(harness, 'long', context, page));
      const [one, two, three] = await Promise.all(pages);
      assert.match(one ?? '', /\n\[page 1 of 3; go on with page 2\]$/);
      assert.match(two ?? '', /\n\[page 2 of 3; go on with page 3\]$/);
      const body = (page: string | undefined) => (page ?? '').replace(/\n\[page \d of 3; go on with page \d\]$/, '');
      assert.ok([one, two].every((page) => body(page).length <= TRANSCRIPT_PAGE && body(page).endsWith('\n')));
      assert.equal(body(one) + body(two) + body(three), whole);
      assert.equal(await agentTranscript(harness, 'Long', context, 4), 'No page 4: Long\'s chat has 3.');
    } finally {
      await instance.close();
    }
  });

  test('each role\'s system section: the view only with initialContext, and the report is never sent twice', async (t) => {
    const options = await temporary(t);
    for (const initialContext of [undefined, () => '<chat>\n</chat>']) {
      const catalog = offlineModels(router({
        Pi: ({ last }) => last ? say('spawned') : call(['spawn_agent', { name: 'M', task: 'spawn S' }]),
        M: ({ user, last }) => user.startsWith('[S]') ? say('relayed') : last ? say('done') : call(['spawn_agent', { name: 'S', task: 'idle' }]),
        S: () => say('idle'),
      }));
      const databasePath = join(options.cwd, `${initialContext ? 'with' : 'without'}.sqlite`);
      const instance = await openAgents({ ...options, databasePath, ...catalog, hooks: initialContext ? { initialContext } : {} });
      try {
        const { harness, root, context } = instance;
        await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
        await settle(instance);
        const system = async (name: string) => JSON.stringify((await entries(harness, await agentId(instance, name), context))
          .flatMap((entry) => entry.model ?? []).filter((message) => message.role === 'system'));
        const [m, s] = [await system('M'), await system('S')];
        assert.match(m, /Do not also send it with send_message/);
        assert.match(s, /it reaches M automatically as \[S\] reply/);
        for (const text of [m, s]) {
          if (initialContext) assert.match(text, /Use it as context only/);
          else assert.doesNotMatch(text, /Use it as context only/);
        }
      } finally {
        await instance.close();
      }
    }
  });

  test('close and reopen mid-flight delivers each message and report exactly once', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const first = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user === 'go' && !last) return call(['spawn_agent', { name: 'M', task: 'work' }]);
        if (last) return say('spawned');
      },
      M: ({ last }) => last ? say('M waiting') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
      S: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    let instance = await openAgents({ ...options, ...first });
    try {
      await (await instance.root.submit({ type: 'input', content: 'go' }, instance.context)).wait(instance.context);
      await started.promise;
    } finally {
      await instance.close();
    }
    const reports: AgentReport[] = [];
    const seen: Turn[] = [];
    const second = offlineModels(router({
      Pi: ({ user }) => user.startsWith('[M]') ? say('Pi noted') : undefined,
      M: ({ user }) => user.startsWith('[M]') ? undefined
        : user === '[S] slow job done' ? say('M relays: S finished') : say('M waiting'),
      S: () => say('slow job done'),
    }, seen));
    instance = await openAgents({ ...options, ...second, hooks: { onReport: (report) => reports.push(report) } });
    try {
      instance.harness.resume();
      await settle(instance);
      await assertExactlyOnce(instance, reports);
      assert.equal(seen.filter((turn) => turn.who === 'S').length, 1);
      assert.equal(seen.filter((turn) => turn.who === 'M' && turn.user === '[S] slow job done').length, 1);
    } finally {
      await instance.close();
    }
  });

  test('SIGKILL mid-flight, then reopen: every delivery happens exactly once', async (t) => {
    const options = await temporary(t);
    const child = fork(new URL('../fixtures/agents-pending.ts', import.meta.url), [options.databasePath, options.cwd],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    assert.ok(child.stderr && child.stdout);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.resume();
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve([code, signal]));
      child.once('error', reject);
    });
    exited.catch(() => {});
    let instance: AgentsInstance | undefined;
    try {
      const timeout = new AbortController();
      const ready = await Promise.race([
        new Promise<Serializable>((resolve) => child.once('message', resolve)),
        exited.then(([code, signal]) => { throw new Error(`fixture exited ${code}/${signal}: ${stderr}`); }),
        delay(20_000, undefined, { signal: timeout.signal })
          .then(() => { throw new Error(`fixture readiness timeout: ${stderr}`); }, () => {}),
      ]).finally(() => timeout.abort());
      assert.deepEqual(ready, { type: 'pending' }, JSON.stringify(ready));
      assert.ok(child.kill('SIGKILL'));
      const [code, signal] = await exited;
      assert.deepEqual([code, signal], [null, 'SIGKILL']);

      const reports: AgentReport[] = [];
      const catalog = offlineModels(router({
        Pi: ({ user }) => user.startsWith('[M]') ? say('Pi noted') : undefined,
        M: ({ user }) => user === '[S] slow job done' ? say('M relays: S finished') : undefined,
        S: () => say('slow job done'),
      }));
      instance = await openAgents({ ...options, ...catalog, hooks: { onReport: (report) => reports.push(report) } });
      // The interrupted model request reran: S's input and its delivery task survived the kill.
      instance.harness.resume();
      await settle(instance);
      await assertExactlyOnce(instance, reports);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => {});
      if (instance) await instance.close();
    }
  });
});

/** Shared by the restart tests: Pi → M → S, with S's model request in flight at the crash. */
async function assertExactlyOnce(instance: AgentsInstance, reports: readonly AgentReport[]) {
  const { harness, context } = instance;
  const s = await entries(harness, await agentId(instance, 'S'), context);
  const m = await entries(harness, await agentId(instance, 'M'), context);
  const root = await entries(harness, ROOT_CONVERSATION_ID, context);
  assert.deepEqual(userTexts(ofKind(s, MessageEntry)), ['[from M] slow job']);
  assert.deepEqual(ofKind(s, AssistantEntry).map(assistantText), ['slow job done']);
  assert.deepEqual(ofKind(m, MessageEntry).map((entry) => entry.data), [{ from: 'Pi', text: 'work' }]);
  assert.ok([...ofKind(m, ReportEntry), ...ofKind(root, ReportEntry)].every((entry) => entry.data.id !== undefined));
  assert.deepEqual(ofKind(m, ReportEntry).map(({ data: { name, text } }) => ({ name, text })), [{ name: 'S', text: 'slow job done' }]);
  assert.deepEqual(ofKind(root, ReportEntry).map(({ data: { name, text } }) => ({ name, text })),
    [{ name: 'M', text: 'M waiting' }, { name: 'M', text: 'M relays: S finished' }]);
  assert.equal(ofKind(root, UserEntry).length, 1);
  // onReport sees what reached Pi in this process; the first report may predate the restart.
  assert.ok(reports.some((report) => report.name === 'M' && report.text === 'M relays: S finished'));
  assert.equal(new Set(reports.map((report) => report.text)).size, reports.length);
}
