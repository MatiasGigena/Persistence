import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import { type ConversationId, type Cursor, type EntryRecord, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { AgentsDoc, agentTranscript } from '../../src/agents/index.ts';
import { openInstance, type Instance } from '../../src/runtime/runtime.ts';
import { call, router, say } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

// An agent's context through the real host wiring (src/runtime): the view its spawn waits for, and the
// pi-durable compaction that bounds it while Pi's own compactions are declined (ADR 0015).

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-agent-context-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'chat.sqlite') };
}

/** Test-only: wait until no task or submission is live anywhere. */
async function settle({ harness, context }: Instance, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}

async function entries({ harness, context }: Instance, conversationId: ConversationId) {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit((tx) => tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor), context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

async function agentId({ harness, context }: Instance, name: string) {
  const agent = (await harness.snapshot(AgentsDoc, context))?.agents[name];
  assert.ok(agent, `no agent ${name}`);
  return agent.conversationId;
}

const firstUserText = (list: readonly EntryRecord[]) => {
  const message = list.flatMap((entry) => entry.model ?? []).find((each) => each.role === 'user');
  assert.ok(message?.role === 'user', 'no user message');
  return typeof message.content === 'string' ? message.content
    : message.content.map((block) => block.type === 'text' ? block.text : '').join('');
};

describe('agent context (offline, host wiring)', { concurrency: false, timeout: 60_000 }, () => {
  test('a spawn waits for the view\'s pending summaries, so the agent sees no placeholder', async (t) => {
    const options = await temporary(t);
    // Over 512 bytes, so its leaf takes a compaction call; it is logged as Pi's run starts, after Pi's own settle.
    const ask = `${'Note every hull colour and every flag in the harbour. '.repeat(12)}Get someone to count the boats, go`;
    const task = 'Count the boats.';
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        // A memory compaction call: slow, so a spawn that did not wait would render a placeholder.
        if (user.includes('Compaction:')) return delay(400).then(() => say('user: count the boats, note hull colours and flags'));
        if (user.endsWith('go')) return last ? say('Bob is on it.') : call(['spawn_agent', { name: 'Bob', task }]);
        if (user.endsWith('[Bob]\n3 boats.\n\nFull chat: zoom("Bob")')) return say('Bob counted 3 boats.');
      },
      Bob: () => say('3 boats.'),
    }));
    const instance = await openInstance({ ...options, ...catalog });
    try {
      await (await instance.root.submit({ type: 'input', content: ask }, instance.context)).wait(instance.context);
      await settle(instance);
      const first = firstUserText(await entries(instance, await agentId(instance, 'Bob')));
      assert.match(first, /^<chat>\n/);
      assert.match(first, /\n0\+1\|user: count the boats, note hull colours and flags\n/);
      assert.doesNotMatch(first, /not summarized yet/);
      assert.ok(first.endsWith(`[from Pi] ${task}`));
      assert.ok((await entries(instance, ROOT_CONVERSATION_ID)).some((entry) => JSON.stringify(entry.model ?? []).includes('Bob counted 3 boats.')));
    } finally {
      await instance.close();
    }
  });

  test('Pi\'s turn state lists the agents at work', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const turns: string[] = [];
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user.includes('Compaction:')) return say('pi: a line');
        turns.push(user);
        if (user.endsWith('go')) return last ? say('spawned') : call(['spawn_agent', { name: 'Slow', task: 'take your time' }]);
        if (user.endsWith('status?')) return say('Slow is working.');
      },
      Slow: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    const instance = await openInstance({ ...options, ...catalog });
    try {
      const ask = async (content: string) => (await instance.root.submit({ type: 'input', content }, instance.context)).wait(instance.context);
      await ask('go');
      assert.match(turns[0] ?? '', /<turn>\nnow: [^\n]+\nagents at work: none\n<\/turn>/);
      await started.promise;
      await ask('status?');
      assert.match(turns.at(-1) ?? '', /\nagents at work: Slow\n<\/turn>/);
    } finally {
      await instance.close();
    }
  });

  test('pi-durable compacts an agent\'s growing context; Pi\'s own compactions stay declined', async (t) => {
    const options = await temporary(t);
    const huge = 'x'.repeat(60_000);
    let summaries = 0;
    // A 30,000-token window: the agent's ~30,000 tokens of tool traffic cross the blocking threshold.
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => {
        if (user.includes('Compaction:')) return say('pi: a line');
        if (user.endsWith('go')) return last ? say('spawned') : call(['spawn_agent', { name: 'Big', task: 'look it up' }]);
        if (user.endsWith('[Big]\nlooked\n\nFull chat: zoom("Big")')) return say('noted');
      },
      Big: ({ last }) => last ? say('looked') : call(['last_message', { name: huge }]),
      // pi-durable's summarization request has its own system prompt.
      unknown: ({ request }) => {
        assert.match(JSON.stringify(request.messages[0]), /context summarization assistant/);
        summaries++;
        return say('## Goal\nLook it up.\n## Progress\nAsked last_message about a long name.');
      },
    }), { contextWindow: 30_000 });
    const instance = await openInstance({ ...options, ...catalog });
    try {
      await (await instance.root.submit({ type: 'input', content: 'go' }, instance.context)).wait(instance.context);
      await settle(instance);
      const big = await entries(instance, await agentId(instance, 'Big'));
      assert.equal(summaries, 1);
      assert.equal(big.filter((entry) => entry.kind === 'pi.compaction').length, 1);
      assert.equal((await entries(instance, ROOT_CONVERSATION_ID)).filter((entry) => entry.kind === 'pi.compaction').length, 0);
      // The compacted run still answered and reported once.
      const reports = (await entries(instance, ROOT_CONVERSATION_ID)).filter((entry) => entry.kind === 'agents.report')
        .map(({ data }) => {
          assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data));
          return [data.name, data.text];
        });
      assert.deepEqual(reports, [['Big', 'looked']]);
      assert.ok((await entries(instance, ROOT_CONVERSATION_ID)).some((entry) => JSON.stringify(entry.model ?? []).includes('noted')));
      // zoom("Big") still gives the whole chat, marking the cut.
      const chat = await agentTranscript(instance.harness, 'Big', instance.context);
      assert.match(chat, /\d+\|note: the context was compacted here/);
      assert.ok(chat.includes(huge));
    } finally {
      await instance.close();
    }
  });
});
