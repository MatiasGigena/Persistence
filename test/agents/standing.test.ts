import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { AgentDoc, type ConversationId, defineExtension, defineTool, type ModelRef, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { AgentsDoc, DEFAULT_ROSTER, type Roster } from '../../src/agents/index.ts';
import { openInstance, type Instance, type InstanceOptions } from '../../src/runtime/runtime.ts';
import { call, router, say, type Turn } from '../fixtures/agents-instance.ts';

// Standing agents (ADR 0027) through the real host wiring: the roster's agents exist from the launch, keep their own
// model, effort and kits through Pi's /model and /effort, and hand them to their sub agents.

const AGENT_TOOLS = ['last_message', 'list_agents', 'send_message', 'spawn_agent', 'stop_agent'];
const CODING = ['bash', 'edit', 'read', 'write'];

async function temporary(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-standing-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, 'chat.sqlite') };
}

/** One faux provider with a model each for Pi, the standing agents and their subs; `router` answers them all. */
function catalog(seen: Turn[] = [], script: Parameters<typeof router>[0] = {}) {
  const faux = fauxProvider({ models: [{ id: 'faux-pi' }, { id: 'faux-coder' }, { id: 'faux-sub' }, { id: 'faux-next' }] });
  faux.setResponses(router(script, seen));
  const models = createModels();
  models.setProvider(faux.provider);
  const ref = (modelId: string): ModelRef => ({ provider: faux.provider.id, modelId });
  return { models, ref };
}

/** A stand-in for the browser kit: an extension of its own, with one tool. */
const FakeBrowser = defineExtension({
  name: 'test-browser',
  tools: [defineTool({ name: 'browser_goto', description: 'Test only.', parameters: Type.Object({ url: Type.String() }),
    execute: async () => ({ output: [{ type: 'text', text: 'ok' }] }) })],
});
const browserKit = { browser: { extension: FakeBrowser, tools: FakeBrowser.tools ?? [] } };

async function settle({ harness, context }: Instance, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const inspection = await harness.inspect(context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    if (Date.now() > until) throw new Error(`not settled: ${JSON.stringify(inspection.tasks.map((task) => task.record.kind))}`);
    await delay(10);
  }
}

const registryOf = async ({ harness, context }: Instance) => (await harness.snapshot(AgentsDoc, context))?.agents ?? {};
/** An agent's stored choices: model id, thinking level, enabled tools (sorted). */
async function stored(instance: Instance, name: string) {
  const agent = (await registryOf(instance))[name];
  assert.ok(agent, `no agent ${name}`);
  const state = await instance.harness.snapshot(AgentDoc, agent.conversationId, instance.context);
  assert.ok(state, `no choices for ${name}`);
  assert.ok(Array.isArray(state.tools), `${name}'s tools are not a list`);
  return { model: state.model?.modelId, thinkingLevel: state.thinkingLevel, tools: [...state.tools].sort() };
}
async function offered(instance: Instance, name: string) {
  const agent = (await registryOf(instance))[name];
  assert.ok(agent, `no agent ${name}`);
  const conversation = await instance.harness.conversation(agent.conversationId, instance.context);
  assert.ok(conversation);
  return (await conversation.agent(instance.context)).tools.map((tool) => tool.name).sort();
}

describe('standing agents (offline, host wiring)', { concurrency: false, timeout: 60_000 }, () => {
  test('a launch creates the roster once; they keep their model, effort and kits; --no-tools drops only coding and read', async (t) => {
    const options = await temporary(t);
    const { models, ref } = catalog([], {
      Pi: ({ user, last }) => user.includes('Start Lead.') && !last ? call(['spawn_agent', { name: 'Lead', task: 'Wait.' }]) : say('ok'),
      Lead: () => say('Lead here.'),
    });
    const roster: Roster = {
      Coder: { model: ref('faux-coder'), thinkingLevel: 'medium', tools: ['coding'] },
      Reviewer: { model: ref('faux-coder'), thinkingLevel: 'xhigh', tools: ['read', 'browser'], instructions: 'Review with care.' },
      Researcher: { model: ref('faux-coder'), thinkingLevel: 'high', tools: ['web_fetch'] },
    };
    const warnings: string[] = [];
    const open = (change: Partial<InstanceOptions> = {}) => openInstance({ ...options, models, model: ref('faux-pi'),
      thinkingLevel: 'high', allowTools: true, roster, kits: browserKit, onWarning: (message) => warnings.push(message), ...change });

    let instance = await open();
    const ids: Record<string, ConversationId> = {};
    try {
      const registry = await registryOf(instance);
      assert.deepEqual(Object.keys(registry).sort(), ['Coder', 'Researcher', 'Reviewer']);
      for (const [name, agent] of Object.entries(registry)) {
        assert.deepEqual([agent.role, agent.parent, agent.standing, agent.reported], ['main', 'Pi', true, []], name);
        ids[name] = agent.conversationId;
      }
      assert.deepEqual(warnings, [], 'the host has every kit');

      assert.deepEqual(await stored(instance, 'Coder'), { model: 'faux-coder', thinkingLevel: 'medium',
        tools: [...AGENT_TOOLS, ...CODING].sort() });
      const reviewer = await stored(instance, 'Reviewer');
      assert.deepEqual([reviewer.model, reviewer.thinkingLevel, reviewer.tools], ['faux-coder', 'xhigh', [...AGENT_TOOLS, 'browser_goto', 'read'].sort()]);
      assert.deepEqual(await offered(instance, 'Reviewer'), [...AGENT_TOOLS, 'browser_goto', 'read'].sort(), 'the kit\'s extension is selected');
      assert.deepEqual(await offered(instance, 'Coder'), [...AGENT_TOOLS, ...CODING].sort(), 'no browser without the kit');
      assert.deepEqual((await stored(instance, 'Researcher')).tools, [...AGENT_TOOLS, 'web_fetch'].sort());

      // An ad-hoc agent, Lead, to compare with.
      const pi = await instance.root.submit({ type: 'input', content: 'Start Lead.' }, instance.context);
      assert.equal((await pi.wait(instance.context)).status, 'done');
      await settle(instance);

      // /model and /effort change Pi and its ad-hoc agents, never the standing ones.
      await instance.setModel(ref('faux-next'));
      await instance.setThinkingLevel('low');
      assert.deepEqual([(await stored(instance, 'Lead')).model, (await stored(instance, 'Lead')).thinkingLevel], ['faux-next', 'low']);
      assert.deepEqual([(await stored(instance, 'Coder')).model, (await stored(instance, 'Coder')).thinkingLevel], ['faux-coder', 'medium']);
      assert.deepEqual([(await stored(instance, 'Reviewer')).model, (await stored(instance, 'Reviewer')).thinkingLevel], ['faux-coder', 'xhigh']);

      // /tools off: coding and read go, the browser stays; on again brings them back.
      await instance.setTools(false);
      assert.deepEqual((await stored(instance, 'Coder')).tools, AGENT_TOOLS);
      assert.deepEqual((await stored(instance, 'Reviewer')).tools, [...AGENT_TOOLS, 'browser_goto'].sort());
      await instance.setTools(true);
      assert.deepEqual((await stored(instance, 'Coder')).tools, [...AGENT_TOOLS, ...CODING].sort());
    } finally {
      await instance.close();
    }

    // A second launch creates nothing new; --no-tools keeps only the browser.
    instance = await open({ allowTools: false });
    try {
      const registry = await registryOf(instance);
      assert.deepEqual(Object.keys(registry).sort(), ['Coder', 'Lead', 'Researcher', 'Reviewer']);
      for (const name of ['Coder', 'Researcher', 'Reviewer']) assert.equal(registry[name]?.conversationId, ids[name], name);
      assert.equal(registry.Lead?.standing, undefined);
      assert.deepEqual((await stored(instance, 'Coder')).tools, AGENT_TOOLS);
      assert.deepEqual((await stored(instance, 'Reviewer')).tools, [...AGENT_TOOLS, 'browser_goto'].sort());
      assert.equal((await stored(instance, 'Coder')).model, 'faux-coder');
    } finally {
      await instance.close();
    }

    // Dropped from the roster: Reviewer stays, as an ordinary agent that follows Pi again.
    const { Reviewer: _dropped, ...rest } = roster;
    instance = await open({ roster: rest });
    try {
      const registry = await registryOf(instance);
      assert.equal(registry.Reviewer?.conversationId, ids.Reviewer);
      assert.equal(registry.Reviewer?.standing, undefined);
      assert.equal(registry.Coder?.standing, true);
      const reviewer = await stored(instance, 'Reviewer');
      assert.deepEqual([reviewer.model, reviewer.thinkingLevel], ['faux-pi', 'high']);
      assert.ok(!reviewer.tools?.includes('browser_goto'));
    } finally {
      await instance.close();
    }
  });

  test('a sub of a standing agent takes its kits and subModel; Pi is told about the standing agents', async (t) => {
    const options = await temporary(t);
    const seen: Turn[] = [];
    const { models, ref } = catalog(seen, {
      Pi: ({ user, last }) => {
        if (user.includes('Start.') && !user.includes('[Coder]') && !last) return call(['send_message', { to: 'Coder', text: 'Build it.' }]);
        return say('ok');
      },
      Coder: ({ user, last }) => {
        if (user.includes('Build it.')) return last ? say('Delegated.') : call(['spawn_agent', { name: 'Helper', task: 'Help.' }]);
        return say('Coder done.');
      },
      Helper: () => say('Helped.'),
    });
    const coder = { model: ref('faux-coder'), thinkingLevel: 'medium', tools: ['coding'], instructions: 'Use tabs.' } as const;
    const open = (roster: Roster) => openInstance({ ...options, models, model: ref('faux-pi'), thinkingLevel: 'high',
      allowTools: true, roster });

    let instance = await open({ Coder: { ...coder, subModel: ref('faux-sub'), subThinkingLevel: 'low' } });
    try {
      const pi = await instance.root.submit({ type: 'input', content: 'Start.' }, instance.context);
      assert.equal((await pi.wait(instance.context)).status, 'done');
      await settle(instance);
      const registry = await registryOf(instance);
      assert.deepEqual([registry.Helper?.role, registry.Helper?.parent, registry.Helper?.standing], ['sub', 'Coder', undefined]);
      assert.deepEqual(await stored(instance, 'Helper'), { model: 'faux-sub', thinkingLevel: 'low',
        tools: [...AGENT_TOOLS, ...CODING].sort() });
      assert.deepEqual(await offered(instance, 'Helper'), ['last_message', 'list_agents', 'send_message', ...CODING].sort(),
        'a sub still loses spawn_agent and stop_agent');

      const system = (who: string) => JSON.stringify(seen.find((turn) => turn.who === who)?.request.messages.filter((message) => message.role === 'system'));
      assert.match(system('Pi'), /Standing agents always exist, each with its own model and tools: Coder \(programming\)\./);
      assert.match(system('Coder'), /Use tabs\./);
      assert.doesNotMatch(system('Helper'), /Use tabs\./);
      const instructions = async (name: string) => (await instance.harness.snapshot(AgentDoc,
        (await registryOf(instance))[name]?.conversationId ?? ROOT_CONVERSATION_ID, instance.context))?.instructions;
      assert.equal(await instructions('Helper'), await instructions('Coder'), 'a sub takes its main agent\'s instructions');
      assert.match(await instructions('Helper') ?? '', /Your tools besides the agent tools: read, write, edit, bash\./);
    } finally {
      await instance.close();
    }

    // Without subModel and subThinkingLevel, the sub takes its main agent's, not Pi's.
    instance = await open({ Coder: coder });
    try {
      const helper = await stored(instance, 'Helper');
      assert.deepEqual([helper.model, helper.thinkingLevel], ['faux-coder', 'medium']);
      await instance.setModel(ref('faux-next'));
      assert.equal((await stored(instance, 'Helper')).model, 'faux-coder', '/model leaves a standing agent\'s subs alone');
    } finally {
      await instance.close();
    }
  });

  test('each default roster agent\'s instructions name its own tools, with tools on and off', async (t) => {
    const options = await temporary(t);
    const { models, ref } = catalog();
    const roster: Roster = Object.fromEntries(Object.entries(DEFAULT_ROSTER).map(([name, agent]) => [name, { ...agent, model: ref('faux-coder') }]));
    const instance = await openInstance({ ...options, models, model: ref('faux-pi'), thinkingLevel: 'high', allowTools: true, roster, kits: browserKit });
    const instructions = async (name: string) => {
      const agent = (await registryOf(instance))[name];
      assert.ok(agent, `no agent ${name}`);
      return (await instance.harness.snapshot(AgentDoc, agent.conversationId, instance.context))?.instructions ?? '';
    };
    const pi = async () => (await instance.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, instance.context))?.instructions ?? '';
    const protectedNote = /Some folders are protected/;
    try {
      // Pi's text that still applies is kept; its line about Pi's coding tools is not.
      for (const name of ['Coder', 'Reviewer', 'Researcher']) {
        const text = await instructions(name);
        assert.match(text, /^You run in a persistent Pi Durable terminal host/, name);
        assert.ok(text.includes(`Your working directory for this launch is ${options.cwd}.`), name);
        assert.doesNotMatch(text, /The read, write, edit, and bash tools are on/, name);
      }
      assert.match(await pi(), /The read, write, edit, and bash tools are on/, 'Pi keeps its own');
      const coder = await instructions('Coder');
      assert.match(coder, /Your tools besides the agent tools: read, write, edit, bash\. You have no others\./);
      assert.match(coder, /bash runs in a sandbox that enforces this/);
      const reviewer = await instructions('Reviewer');
      assert.match(reviewer, /Your tools besides the agent tools: read, browser_goto\. You have no others\./);
      assert.match(reviewer, protectedNote);
      assert.doesNotMatch(reviewer, /bash/);
      assert.match(reviewer, /You cannot change files or run commands/);
      const researcher = await instructions('Researcher');
      assert.match(researcher, /Your tools besides the agent tools: web_fetch\. You have no others\./);
      assert.doesNotMatch(researcher, protectedNote);
      assert.match(researcher, /You cannot read or change local files or run commands/);
      assert.doesNotMatch(researcher, /\b(bash|write|edit)\b/);

      // Tools off: the local kits' tools are named as off; nobody is told it has them.
      await instance.setTools(false);
      const off = await instructions('Coder');
      assert.match(off, /You have no tools besides the agent tools\./);
      assert.match(off, /Your local tools \(read, write, edit, bash\) are off for this launch; only the user can turn them on\./);
      assert.doesNotMatch(off, protectedNote);
      const reviewerOff = await instructions('Reviewer');
      assert.match(reviewerOff, /Your tools besides the agent tools: browser_goto\. You have no others\./);
      assert.match(reviewerOff, /Your local tools \(read\) are off/);
      assert.match(reviewerOff, /You cannot read or change local files or run commands/);
      assert.equal(await instructions('Researcher'), researcher, 'no local kits: nothing changes');
      await instance.setTools(true);
      assert.equal(await instructions('Coder'), coder, 'on again');
    } finally {
      await instance.close();
    }
  });

  test('a name collision makes the existing ad-hoc agent the standing one', async (t) => {
    const options = await temporary(t);
    const { models, ref } = catalog([], {
      Pi: ({ user, last }) => user.includes('Go.') && !last ? call(['spawn_agent', { name: 'coder', task: 'Wait.' }]) : say('ok'),
      coder: () => say('here'),
    });
    const base = { ...options, models, model: ref('faux-pi'), thinkingLevel: 'high', allowTools: true } as const;
    let instance = await openInstance({ ...base, roster: {} });
    try {
      const pi = await instance.root.submit({ type: 'input', content: 'Go.' }, instance.context);
      assert.equal((await pi.wait(instance.context)).status, 'done');
      await settle(instance);
    } finally {
      await instance.close();
    }
    instance = await openInstance({ ...base, roster: { Coder: { model: ref('faux-coder'), thinkingLevel: 'medium', tools: [] } } });
    try {
      const registry = await registryOf(instance);
      assert.deepEqual(Object.keys(registry), ['coder'], 'no second agent');
      assert.equal(registry.coder?.standing, true);
      assert.deepEqual([(await stored(instance, 'coder')).model, (await stored(instance, 'coder')).tools], ['faux-coder', AGENT_TOOLS]);
      const root = await instance.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, instance.context);
      assert.equal(root?.model?.modelId, 'faux-pi');
    } finally {
      await instance.close();
    }
  });
});
