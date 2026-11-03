import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import {
  createRegistry, type JsonObject, ROOT_CONVERSATION_ID, type TaskId, type ToolExecutionApi, type ToolRegistration,
} from '@earendil-works/pi-durable';
import {
  AgentsDoc, agentTranscript, createAgentsExtension, deleteAgent, deleteText, listAgents, type Roster, stopAgents,
} from '../../src/agents/index.ts';
import { type AgentsInstance, call, openAgents, router, say } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-delete-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'agents.sqlite') };
}

async function settle({ harness, context }: AgentsInstance, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error('not settled');
    await delay(10);
  }
}

/** Run an agents tool directly, as conversation `conversationId`. */
function executor(instance: AgentsInstance, models: ToolExecutionApi['models']) {
  const { harness, context } = instance;
  const tools = Object.fromEntries(createAgentsExtension().tools.map((tool): [string, ToolRegistration] => [tool.name, tool]));
  const unused = (): never => { throw new Error('not used by the agents tools'); };
  return async (name: string, args: JsonObject, conversationId = ROOT_CONVERSATION_ID) => {
    const tool = tools[name];
    assert.ok(tool, `no tool ${name}`);
    const api: ToolExecutionApi = {
      taskId: await instance.storage.mintId<TaskId>(), conversationId, callId: 'direct',
      registry: createRegistry().snapshot(), models, env: undefined, outputWindow: undefined,
      snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness),
      watchDoc: harness.watchDoc.bind(harness), commit: harness.commit.bind(harness),
      agent: unused, output: unused, retainedOutput: unused, diagnostic: unused, details: unused, memo: unused,
      createTask: unused, getTask: unused, waitForTask: unused, conversation: unused, executeTool: unused, now: Date.now,
    };
    const block = (await tool.execute(args, api, context)).output?.[0];
    assert.ok(block?.type === 'text');
    return block.text;
  };
}

const ROSTER: Roster = { Coder: { model: { provider: 'faux', modelId: 'one' }, thinkingLevel: 'off', tools: [] } };

describe('delete_agent (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('Pi deletes an idle main with its subs; chats stay zoomable; the name is free again', async (t) => {
    const options = await temporary(t);
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => user === 'go' ? (last ? say('spawned') : call(['spawn_agent', { name: 'Lead', task: 'spawn S' }]))
        : user === 'again' ? (last ? say(last.text) : call(['spawn_agent', { name: 'Lead', task: 'again' }])) : say('noted'),
      Lead: ({ user, last }) => user.endsWith('again') ? say('back') : last ? say('S is on it') : call(['spawn_agent', { name: 'S', task: 'idle' }]),
      S: () => say('S idles.'),
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await settle(instance);
      const execute = executor(instance, catalog.models);
      const lead = (await harness.snapshot(AgentsDoc, context))?.agents.Lead?.conversationId;
      const sub = (await harness.snapshot(AgentsDoc, context))?.agents.S?.conversationId;
      assert.ok(lead && sub);
      // Only Pi deletes; never Pi itself, an unknown name, or a standing agent.
      assert.equal(await execute('delete_agent', { name: 'S' }, lead), 'Only Pi can delete agents.');
      assert.equal(await execute('delete_agent', { name: 'pi' }), 'Pi cannot be deleted.');
      assert.equal(await execute('delete_agent', { name: 'nobody' }), 'No agent named nobody. The agents are Lead, S.');
      await assert.rejects(agentTranscript(harness, 'Laed', context), { message: 'No agent named Laed. The agents are Lead, S.' });
      assert.deepEqual(await deleteAgent(harness, context, 'lead', { Lead: ROSTER.Coder! }),
        { error: 'Lead is a standing agent; it can be deleted only after it leaves the roster.' });
      assert.deepEqual((await listAgents(harness, context)).map((agent) => agent.name).sort(), ['Lead', 'S']);

      assert.equal(await execute('delete_agent', { name: 'lead' }),
        'Deleted Lead and its sub agents S. Their chats stay readable with zoom("Lead").');
      assert.deepEqual(await listAgents(harness, context), []);
      const registry = await harness.snapshot(AgentsDoc, context);
      assert.deepEqual(registry?.deleted, { S: [sub], Lead: [lead] });
      assert.match(await agentTranscript(harness, 'S', context), /^S was deleted; its chat is kept\n\n.*\|S: S idles\./s);
      assert.match(await agentTranscript(harness, 'Lead', context), /Lead was deleted/);
      assert.equal(await execute('send_message', { to: 'Lead', text: 'x' }), 'No agent named Lead. There are none.');
      assert.equal(await execute('delete_agent', { name: 'Lead' }), 'No agent named Lead. There are none.');
      const again = await (await root.submit({ type: 'input', content: 'again' }, context)).wait(context);
      assert.equal(again.status, 'done');
      await settle(instance);
      assert.doesNotMatch(await agentTranscript(harness, 'Lead', context), /was deleted/, 'a live agent wins over a deleted name');
    } finally {
      await instance.close();
    }
  });

  test('a busy agent or sub is refused until stopped', async (t) => {
    const options = await temporary(t);
    const started = Promise.withResolvers<void>();
    const catalog = offlineModels(router({
      Pi: ({ user, last }) => user === 'go' ? (last ? say('spawned') : call(['spawn_agent', { name: 'Lead', task: 'spawn S' }])) : say('noted'),
      Lead: ({ last }) => last ? say('S is on it') : call(['spawn_agent', { name: 'S', task: 'slow job' }]),
      S: async ({ signal }) => { started.resolve(); await delay(60_000, undefined, { signal }).catch(() => {}); return say('never'); },
    }));
    const instance = await openAgents({ ...options, ...catalog });
    try {
      const { harness, root, context } = instance;
      await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context);
      await started.promise;
      const refused = await deleteAgent(harness, context, 'Lead');
      assert.ok('error' in refused && /\bS\b.* busy; stop_agent Lead first/.test(refused.error), deleteText(refused));
      assert.equal((await listAgents(harness, context)).length, 2);
      await stopAgents(harness, context, 'Lead');
      await settle(instance);
      assert.deepEqual(await deleteAgent(harness, context, 'Lead'), { deleted: ['S', 'Lead'] });
      assert.deepEqual(await listAgents(harness, context), []);
    } finally {
      await instance.close();
    }
  });

  test('deleteText words a single agent', () => {
    assert.equal(deleteText({ deleted: ['probe'] }), 'Deleted probe. Its chat stays readable with zoom("probe").');
  });
});
