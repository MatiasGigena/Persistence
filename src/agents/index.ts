import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import {
  AgentDoc, AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool,
  hook, LiveDoc, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';

/**
 * Multi-agent messaging for the one UniiChat chat (Pi = the root conversation).
 *
 *   Pi ─┬─ main agent ─┬─ sub agent       Pi spawns mains, mains spawn subs, subs cannot spawn.
 *       │              └─ sub agent       Everyone lists, messages, and reads the last message of
 *       └─ main agent ── sub agent        every agent; only mains (and Pi) address "Pi".
 *
 * Each agent is its own persistent conversation, owned by a background anchor task of its spawner's
 * conversation (upstream example 23), so Pi's Esc and idle waits never reach it. Every input to an
 * agent is carried by a durable background Deliver task: it submits the input with a request ID
 * derived from its task ID, waits for the agent's answer, and in the same commit that records the
 * answer as reported it creates the next Deliver task that carries `[Name] answer` to the parent.
 * Reports to Pi are not awaited. A restart resumes each Deliver task from its last checkpoint and the
 * request IDs make every resubmission return the first one, so nothing is lost or delivered twice.
 * Tool calls that create deliveries are replay-safe and keyed by their tool task ID.
 *
 * Host wiring (src/runtime/runtime.ts):
 *   const Agents = createAgentsExtension({ initialContext, onReport });
 *   registry.install(Agents);                       // also on inspect-only launches: tasks stay known
 *   agent.extensions = [CodingTools, Agents, ...];  // the root's array selects exactly these
 *   agent.tools = [...(allowTools ? CodingTools.tools : []), ...Agents.tools];  // an array enables exactly these
 *   await root.configure(agent, context);
 *   await syncAgents(harness, context);             // every work launch, right after root.configure()
 *   harness.resume();                               // on work launches, so pending deliveries continue
 * Pi is always ROOT_CONVERSATION_ID; nothing else needs configuring and no settings are required.
 * Every input reaching Pi (a main agent's final report or its send_message) is the user message
 * `[Name] text`, placed as the entry `{ kind: 'agents.report', data: { name, text, id } }`; inputs to
 * other agents are `agents.message` (`[from Name] text`, data `{ from, text }`) or `agents.report`.
 * Pi's answers to them are ordinary root runs that no `submission.wait()` of the host awaits, so a
 * host that prints answers must watch the root. Deliveries are background tasks: `root.waitForIdle()`
 * and Pi's Esc (`root.abort()`) do not reach them; `root.abort(ctx, { background: true })` does.
 */

export const PI = 'Pi';
export const REPORT_KIND = 'agents.report';
export const MESSAGE_KIND = 'agents.message';
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const KEEP_CALLS = 256;
const KEEP_REPORTED = 32;

/** Session-wide registry: name → { conversationId, role: 'main'|'sub', parent: 'Pi'|main name, reported }. */
export const AgentsDoc = defineDoc({
  kind: 'agents.registry',
  version: 1,
  scope: 'session',
  initial: () => ({ agents: {}, calls: {} }),
});

const text = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
const assistantText = (entry) => (entry?.model ?? [])
  .filter((message) => message.role === 'assistant').map((message) => text(message.content)).join('');
const reply = (value) => ({ output: [{ type: 'text', text: value }] });
const brief = (value, max = 120) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const find = (agents, name) => {
  const key = Object.keys(agents).find((each) => each.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? undefined : { name: key, ...agents[key] };
};

/** Who the conversation is: Pi, a registered agent, or undefined for any other conversation. */
function whoIs(registry, conversationId) {
  if (conversationId === ROOT_CONVERSATION_ID) return { name: PI, role: 'root', conversationId };
  for (const [name, agent] of Object.entries(registry?.agents ?? {})) {
    if (agent.conversationId === conversationId) return { name, ...agent };
  }
  return undefined;
}

/** Resolve a target; `Pi` only for those who may address it. */
function target(registry, me, name) {
  if (String(name).toLowerCase() === PI.toLowerCase()) {
    if (me.role === 'sub') return { error: 'Sub agents cannot address Pi; message your main agent instead.' };
    return { name: PI, role: 'root', conversationId: ROOT_CONVERSATION_ID };
  }
  return find(registry?.agents ?? {}, name) ?? { error: `No agent named ${name}.` };
}

/** Latest committed assistant text of a conversation, read through a transaction. */
async function lastAnswer(tx, conversationId) {
  let cursor;
  for (let pages = 0; pages < 8; pages++) {
    const page = await tx.scanEntries({ conversationId }, 64, cursor);
    for (const entry of page.items) {
      if (entry.kind === 'pi.assistant' && assistantText(entry)) return assistantText(entry);
    }
    if ((cursor = page.next) === undefined) break;
  }
  return undefined;
}

const busyOf = async (source, conversationId, context) =>
  (await source.snapshot(LiveDoc, conversationId, context))?.run !== undefined;

/**
 * Make an agent's stored choices those of Pi: model, thinking level, extensions, tools, cwd, and
 * instructions; then the role's tool offer (subs are not offered spawn_agent or stop_agent), then the
 * host's `childAgent` change.
 */
async function deriveAgent(tx, conversationId, role, childAgent) {
  const root = JSON.parse(JSON.stringify(await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)));
  const state = await tx.doc(AgentDoc, conversationId);
  for (const key of Object.keys(state)) if (!(key in root)) delete state[key];
  // Assigned whole; a write of an equal value records no change.
  for (const [key, value] of Object.entries(root)) state[key] = value;
  if (role === 'sub') {
    const hidden = ['spawn_agent', 'stop_agent'];
    const offered = state.modelTools;
    state.modelTools = Array.isArray(offered) ? offered.filter((name) => !hidden.includes(name))
      : { ...offered, remove: [...new Set([...(offered?.remove ?? []), ...hidden])] };
  }
  if (childAgent) await configure(tx, conversationId, childAgent);
}

/**
 * Re-derive every spawned agent's choices from Pi's, e.g. after the host reconfigured the root for
 * this launch (tools on/off, model). Call on every work launch after `root.configure()`.
 */
export async function syncAgents(harness, context = BACKGROUND_CONTEXT, { childAgent } = {}) {
  await harness.commit(async (tx) => {
    const { agents } = await tx.doc(AgentsDoc);
    for (const agent of Object.values(agents)) await deriveAgent(tx, agent.conversationId, agent.role, childAgent);
  }, context);
}

/** Every spawned agent with its role, parent, conversation, and busy state. */
export async function listAgents(source, context = BACKGROUND_CONTEXT) {
  const registry = await source.snapshot(AgentsDoc, context);
  return Promise.all(Object.entries(registry?.agents ?? {}).map(async ([name, agent]) => ({
    name, role: agent.role, parent: agent.parent, conversationId: agent.conversationId,
    busy: await busyOf(source, agent.conversationId, context),
  })));
}

/**
 * An agent's whole chat as plain text (backs the memory's `zoom("Name")`). `source` is the Harness
 * or a tool's `api` (anything with `snapshot()` and `commit(tx => …)`); `name` may be "Pi".
 */
export async function agentTranscript(source, name, context = BACKGROUND_CONTEXT) {
  const registry = await source.snapshot(AgentsDoc, context);
  const agent = String(name).toLowerCase() === PI.toLowerCase()
    ? { name: PI, conversationId: ROOT_CONVERSATION_ID } : find(registry?.agents ?? {}, name);
  if (!agent) throw new Error(`No agent named ${name}`);
  const entries = [];
  let cursor;
  do {
    const page = await source.commit((tx) => tx.scanEntries(
      { conversationId: agent.conversationId, order: 'ascending' }, 256, cursor), context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const lines = [];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === 'user') lines.push(`> ${text(message.content)}`);
      else if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) lines.push(`${agent.name}: ${block.text}`);
          else if (block.type === 'toolCall') lines.push(`  ${block.name}(${JSON.stringify(block.arguments)})`);
        }
      } else if (message.role === 'toolResult') {
        lines.push(`  → ${brief(text(message.content), 500)}`);
      }
    }
  }
  return lines.join('\n');
}

const ROLE_TEXT = {
  root: () => [
    'You are Pi, the session agent of this chat.',
    'You can start background agents ("main agents") with spawn_agent(name, task), and use list_agents, send_message(to, text), last_message(name), and stop_agent(name) to steer them.',
    'Agents work in the background. Never wait for one (no sleep, no polling): go on, or end your turn.',
    'When a main agent finishes a run, its final reply arrives here as a message starting with [Name]; main agents can also message you mid-run the same way.',
  ],
  main: (me) => [
    `You are "${me.name}", a main agent spawned by Pi, the session agent. Your work happens in your own conversation.`,
    'You can start sub agents with spawn_agent(name, task), and use list_agents, send_message(to, text), last_message(name), and stop_agent(name) on your own sub agents. send_message and last_message also accept "Pi".',
    'Messages reach you as [from Name] text; your sub agents\' final replies reach you as [Name] text.',
    `Your final reply at the end of each run is reported to Pi automatically as [${me.name}] reply, so make it a self-contained report.`,
    'Agents work in the background. Never wait for one (no sleep, no polling): go on, or end your turn.',
  ],
  sub: (me) => [
    `You are "${me.name}", a sub agent working for the main agent "${me.parent}". Your work happens in your own conversation.`,
    'You can use list_agents, send_message(to, text), and last_message(name) with any other agent except Pi. You cannot spawn agents or address Pi.',
    'Messages reach you as [from Name] text.',
    `Your final reply at the end of each run is reported to ${me.parent} automatically as [${me.name}] reply, so make it a self-contained report.`,
    'Never wait for another agent (no sleep, no polling): go on, or end your turn.',
  ],
};

/**
 * Build the agents extension.
 * - `initialContext({ name, role, parent, task }, api, context)` returns an optional preamble placed
 *   before a new agent's first task (string, undefined, or a promise of either). `api` is the
 *   spawning tool call's api; read through it, never through the Harness inside a commit.
 * - `onReport({ name, text })` is called after an input from agent `name` was durably admitted to
 *   Pi (a final report or a send_message). At most once per input; the durable record is the
 *   `agents.report` entry itself.
 * - `childAgent` is an AgentChange applied to every spawned agent after it copies Pi's choices.
 */
export function createAgentsExtension({ initialContext, onReport, childAgent } = {}) {
  // Owner of an agent's conversation: finishes at once; background, so Pi's Esc never reaches it.
  const Anchor = defineTask({
    name: 'agents.anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, context) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  // Carries one input to one agent, then that agent's answer to its parent.
  // input: { to, conversationId, content, entry, whenBusy }
  const Deliver = defineTask({
    name: 'agents.deliver',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { to, conversationId, content, entry, whenBusy } = task.input;
        const done = () => ({ status: 'terminal', outcome: { status: 'completed', result: null } });
        const conversation = await runtime.conversation(conversationId, context);
        if (!conversation) return runtime.commit(done, context);
        // A report carries its delivery's id, so memory logs each report once, even identical ones.
        const placed = entry.kind === REPORT_KIND ? { ...entry, data: { ...entry.data, id: task.id } } : entry;
        const submission = await conversation.submit({
          type: 'input', content, entry: placed, whenBusy, requestId: `agents:${task.id}`,
        }, context);
        if (conversationId === ROOT_CONVERSATION_ID) {
          await runtime.commit(done, context);
          try { await onReport?.({ name: entry.data.name, text: entry.data.text, id: task.id }); }
          catch (error) { runtime.report(error); }
          return;
        }
        const settled = await submission.wait(context);
        // One commit records the answer as reported and creates its delivery to the parent.
        await runtime.commit(async (tx) => {
          let report;
          const answer = settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined;
          const answerEntry = answer && await tx.entry(AssistantEntry, answer);
          const registry = await tx.doc(AgentsDoc);
          const agent = registry.agents[to];
          if (!agent) return done();
          if (settled.status === 'unanswered') {
            if (settled.reason !== 'aborted') report = `failed: ${settled.reason}`;
          } else if (answer && !agent.reported.includes(answer)) {
            agent.reported.push(answer);
            if (agent.reported.length > KEEP_REPORTED) agent.reported.splice(0, agent.reported.length - KEEP_REPORTED);
            report = assistantText(answerEntry) || undefined;
          }
          if (report !== undefined) {
            const parent = agent.parent === PI ? ROOT_CONVERSATION_ID : registry.agents[agent.parent]?.conversationId;
            if (parent) await createDelivery(tx, parent, agent.parent, `[${to}] ${report}`,
              { kind: REPORT_KIND, data: { name: to, text: report } }, 'followUp');
          }
          return done();
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const createDelivery = (tx, conversationId, to, content, entry, whenBusy) =>
    tx.createTask(Deliver, { to, conversationId, content, entry, whenBusy },
      { ownership: { kind: 'conversation' }, background: true });

  /** Run `change` once per tool call: a replayed call returns the first result. */
  const once = async (api, context, change) => {
    const recorded = (await api.snapshot(AgentsDoc, context))?.calls?.[api.taskId];
    if (recorded !== undefined) return reply(recorded);
    return reply(await api.commit(async (tx) => {
      const registry = await tx.doc(AgentsDoc);
      if (registry.calls[api.taskId] !== undefined) return registry.calls[api.taskId];
      const result = await change(tx, registry);
      registry.calls[api.taskId] = result;
      const keys = Object.keys(registry.calls);
      for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_CALLS))) delete registry.calls[key];
      return result;
    }, context));
  };

  const me = async (api, context) => whoIs(await api.snapshot(AgentsDoc, context), api.conversationId);

  const spawnAgent = defineTool({
    name: 'spawn_agent',
    description: 'Start a new persistent agent that works on `task` in the background, in its own conversation. '
      + 'Pi spawns main agents; main agents spawn sub agents. Returns at once: never wait or poll for it. '
      + 'Its final reply arrives later as a message starting with [Name].',
    parameters: Type.Object({
      name: Type.String({ description: 'Unique short name: letters, digits, _ or -, at most 32 characters.' }),
      task: Type.String({ description: 'What the agent should do.' }),
    }),
    replay: 'safe',
    execute: async ({ name, task }, api, context) => {
      const caller = await me(api, context);
      if (!caller || caller.role === 'sub') return reply('Sub agents cannot spawn agents.');
      const role = caller.role === 'root' ? 'main' : 'sub';
      if (!NAME.test(name) || name.toLowerCase() === PI.toLowerCase()) {
        return reply('Invalid name: use 1–32 letters, digits, _ or -, and not "Pi".');
      }
      const recorded = (await api.snapshot(AgentsDoc, context))?.calls?.[api.taskId];
      const preamble = recorded === undefined && initialContext
        ? await initialContext({ name, role, parent: caller.name, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${caller.name}] ${task}`;
      return once(api, context, async (tx, registry) => {
        if (find(registry.agents, name)) return `An agent named ${find(registry.agents, name).name} already exists; use send_message.`;
        const background = { ownership: { kind: 'conversation' }, background: true };
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
        await deriveAgent(tx, child.id, role, childAgent);
        registry.agents[name] = { conversationId: child.id, role, parent: caller.name, reported: [] };
        await createDelivery(tx, child.id, name, content,
          { kind: MESSAGE_KIND, data: { from: caller.name, text: task } }, 'followUp');
        return `Started ${role} agent ${name}. Its report will arrive as a message starting with [${name}].`;
      });
    },
  });

  const listAgentsTool = defineTool({
    name: 'list_agents',
    description: 'List all other agents: name, role (main/sub), parent, busy or idle, and a one-line last message.',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return reply('This conversation is not an agent.');
      const others = [
        ...(caller.role === 'main' ? [{ name: PI, role: 'session agent', conversationId: ROOT_CONVERSATION_ID }] : []),
        ...Object.entries(registry?.agents ?? {}).filter(([name]) => name !== caller.name)
          .map(([name, agent]) => ({ name, ...agent, role: `${agent.role}, parent ${agent.parent}` })),
      ];
      if (!others.length) return reply('No other agents.');
      const last = await api.commit(async (tx) => {
        const answers = {};
        for (const agent of others) answers[agent.name] = await lastAnswer(tx, agent.conversationId);
        return answers;
      }, context);
      const lines = await Promise.all(others.map(async (agent) => {
        const state = await busyOf(api, agent.conversationId, context) ? 'busy' : 'idle';
        const said = last[agent.name] === undefined ? 'no message yet' : `last: ${brief(last[agent.name])}`;
        return `- ${agent.name} (${agent.role}) ${state} — ${said}`;
      }));
      return reply(lines.join('\n'));
    },
  });

  const sendMessage = defineTool({
    name: 'send_message',
    description: 'Send `text` to another agent by name. Main agents may also send to "Pi", the session agent; sub agents may not. '
      + 'A busy agent sees it between its tool calls; an idle one starts working on it. Returns at once: never wait for a reply.',
    parameters: Type.Object({
      to: Type.String({ description: 'Agent name, or "Pi" (main agents only).' }),
      text: Type.String(),
    }),
    replay: 'safe',
    execute: async ({ to, text: message }, api, context) => {
      const caller = await me(api, context);
      if (!caller) return reply('This conversation is not an agent.');
      return once(api, context, async (tx, registry) => {
        const found = target(registry, caller, to);
        if (found.error) return found.error;
        if (found.name === caller.name) return 'You cannot message yourself.';
        const entry = found.role === 'root'
          ? { kind: REPORT_KIND, data: { name: caller.name, text: message } }
          : { kind: MESSAGE_KIND, data: { from: caller.name, text: message } };
        const content = found.role === 'root' ? `[${caller.name}] ${message}` : `[from ${caller.name}] ${message}`;
        await createDelivery(tx, found.conversationId, found.name, content, entry, 'steer');
        return `Sent to ${found.name}.`;
      });
    },
  });

  const lastMessage = defineTool({
    name: 'last_message',
    description: 'Get an agent\'s latest reply and whether it is busy. Main agents may also ask for "Pi"; sub agents may not.',
    parameters: Type.Object({ name: Type.String() }),
    replay: 'safe',
    execute: async ({ name }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return reply('This conversation is not an agent.');
      const found = target(registry, caller, name);
      if (found.error) return reply(found.error);
      const said = await api.commit((tx) => lastAnswer(tx, found.conversationId), context);
      const state = await busyOf(api, found.conversationId, context) ? 'busy' : 'idle';
      return reply(`${found.name} is ${state}. ${said === undefined ? 'No message yet.' : `Last message:\n${said}`}`);
    },
  });

  const stopAgent = defineTool({
    name: 'stop_agent',
    description: 'Stop an agent\'s current work and drop its queued messages; it stays and can be messaged again. '
      + 'Pi may stop any agent; a main agent only its own sub agents.',
    parameters: Type.Object({ name: Type.String() }),
    // A rerun after a crash could stop newer work.
    replay: 'unsafe',
    execute: async ({ name }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const caller = whoIs(registry, api.conversationId);
      const found = find(registry?.agents ?? {}, name);
      if (!caller || caller.role === 'sub') return reply('Sub agents cannot stop agents.');
      if (!found) return reply(`No agent named ${name}.`);
      if (caller.role === 'main' && found.parent !== caller.name) return reply(`${found.name} is not your sub agent.`);
      await (await api.conversation(found.conversationId, context))?.abort(context);
      return reply(`Stopped ${found.name}.`);
    },
  });

  // Tool-level guard, before a call's intent is recorded: what a role may not do never runs.
  const guard = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (!['spawn_agent', 'stop_agent', 'send_message', 'last_message'].includes(call.name)) return undefined;
      const caller = whoIs(await api.snapshot(AgentsDoc, context), api.conversationId);
      if (caller?.role !== 'sub') return undefined;
      if (call.name === 'spawn_agent' || call.name === 'stop_agent') return { block: `Sub agents cannot use ${call.name}.` };
      const addressed = call.name === 'send_message' ? call.arguments?.to : call.arguments?.name;
      if (String(addressed).toLowerCase() === PI.toLowerCase()) {
        return { block: 'Sub agents cannot address Pi; message your main agent instead.' };
      }
      return undefined;
    },
  });

  return defineExtension({
    name: 'agents',
    tasks: [Anchor, Deliver],
    tools: [spawnAgent, listAgentsTool, sendMessage, lastMessage, stopAgent],
    hooks: [guard],
    sections: [section('agents', async (input, context) => {
      const caller = whoIs(await input.read.snapshot(AgentsDoc, context), input.conversationId);
      return caller && ROLE_TEXT[caller.role](caller).join('\n');
    })],
  });
}
