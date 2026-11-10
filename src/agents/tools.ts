// The agent tools (spawn_agent, delegate, list_agents, send_message, last_message, stop_agent, delete_agent; persisted
// names, frozen) and the guard hook that refuses what a role may not do before a call's intent is recorded.
import type { Context } from '@earendil-works/chord/context';
import type { Draft } from '@earendil-works/chord/delta';
import { ROOT_CONVERSATION_ID, ToolTask, defineTool, hook } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import type { ConversationId, ToolExecutionApi, ToolRegistration, Tx } from '@earendil-works/pi-durable';
import { isAgentName } from './roster.ts';
import type { Roster } from './roster.ts';
import { MESSAGE_KIND, REPORT_KIND } from './entries.ts';
import { PI, KEEP_CALLS, piReportText, AgentsDoc, toolReply, brief, findAgent, noAgent, archivedSince, archivedRefusal, whoIs, addressee, agentAnswer, conversationBusy, agentBusy, subsOf, sessionNumber, staleSub, Anchor, TASK_OPTIONS, messageRefusal, busyNames } from './registry.ts';
import type { AgentsState, MessageEntry, ReportEntry, Answer } from './registry.ts';
import type { deliveries } from './delivery.ts';
import { deliveryTargets } from './delivery.ts';
import { deriveAgent } from './setup.ts';
import type { AgentsOptions } from './setup.ts';
import { stopAgents, deleteText, removeAgent } from './lifecycle.ts';

/** What the agents tools share: the extension's options, the roster, and how to create a delivery. */
export interface ToolDeps {
  readonly options: AgentsOptions;
  readonly roster: Roster;
  readonly createDelivery: ReturnType<typeof deliveries>['createDelivery'];
}

/** Run `change` once per tool call: a replayed call returns the first result. */
export const oncePerCall = async (api: ToolExecutionApi, context: Context,
  change: (tx: Tx, registry: Draft<AgentsState>) => Promise<string>) => {
  const recorded = (await api.snapshot(AgentsDoc, context))?.calls?.[api.taskId];
  if (recorded !== undefined) return toolReply(recorded);
  return toolReply(await api.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    const first = registry.calls[api.taskId];
    if (first !== undefined) return first;
    const result = await change(tx, registry);
    registry.calls[api.taskId] = result;
    const keys = Object.keys(registry.calls);
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_CALLS))) delete registry.calls[key];
    return result;
  }, context));
};

export const callerOf = async (api: ToolExecutionApi, context: Context) => whoIs(await api.snapshot(AgentsDoc, context), api.conversationId);

export function spawnAgentTool(deps: ToolDeps): ToolRegistration {
  const { options, createDelivery } = deps;
  const { initialContext, onSpawn } = deps.options;
  return defineTool({
    name: 'spawn_agent',
    description: 'Start a new persistent agent that works on `task` in the background, in its own conversation. '
      + 'Pi spawns main agents; main agents spawn sub agents. Returns at once: never wait or poll for it. '
      + 'Its final reply arrives later as a message starting with [Name]. It sees Pi\'s view and the user\'s instructions, '
      + 'but knows what you want only from its task, so say all it needs.',
    parameters: obj({
      name: str({ description: 'Unique short name: a letter, then letters, digits, _ or -, at most 32 characters.' }),
      task: str({ description: 'What the agent should do.' }),
    }, { open: true }),
    replay: 'safe',
    execute: async ({ name, task }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const caller = whoIs(registry, api.conversationId);
      if (!caller || caller.role === 'sub') return toolReply('Sub agents cannot spawn agents.');
      const role = caller.role === 'root' ? 'main' : 'sub';
      if (!isAgentName(name)) {
        return toolReply('Invalid name: use a letter, then up to 31 letters, digits, _ or -, and not "Pi".');
      }
      const recorded = registry?.calls?.[api.taskId];
      const preamble = recorded === undefined && initialContext
        ? await initialContext({ name, role, parent: caller.name, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${caller.name}] ${task}`;
      return oncePerCall(api, context, async (tx, registry) => {
        const existing = findAgent(registry.agents, name);
        if (existing?.standing && caller.role === 'root') {
          return `${existing.name} is a standing agent: give it a new task with delegate, or steer its current one with send_message.`;
        }
        if (existing) return archivedRefusal(registry.agents, existing.name) ?? `An agent named ${existing.name} already exists; use send_message.`;
        // An archived main agent was stopped, so cannot be here; checked anyway, since its subs would be archived too.
        const own = archivedRefusal(registry.agents, caller.name);
        if (own !== undefined) return own;
        const anchor = await tx.createTask(Anchor, null, TASK_OPTIONS);
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
        await onSpawn?.(tx, api.conversationId, child.id);
        // A sub of a standing agent works for the session that spawned it.
        const session = role === 'sub' && registry.agents[caller.name]?.standing ? { session: api.conversationId } : {};
        registry.agents[name] = { conversationId: child.id, role, parent: caller.name, reported: [], ...session };
        await deriveAgent(tx, registry.agents, name, options);
        await createDelivery(tx, {
          to: name, conversationId: child.id, content, whenBusy: 'followUp', entry: { kind: MESSAGE_KIND, data: { from: caller.name, text: task } },
        }, { source: api.conversationId });
        return `Started ${role} agent ${name}. Its report will arrive as a message starting with [${name}].`;
      });
    },
  });
}

export function delegateTool(deps: ToolDeps): ToolRegistration {
  const { options, createDelivery } = deps;
  const { initialContext, onSpawn } = deps.options;
  return defineTool({
    name: 'delegate',
    description: 'Give a standing agent a new task. It starts in a fresh conversation (a new session) that begins with '
      + 'your view; its earlier sessions stay readable with zoom("Name#n"). Refused while the agent or a sub agent of its task is busy: steer or '
      + 'question the work in progress with send_message instead. Returns at once: never wait or poll for it. Its final '
      + 'reply arrives later as a message starting with [Name]. It knows what you want only from its task, so say all it needs.',
    parameters: obj({
      agent: str({ description: 'A standing agent\'s name.' }),
      task: str({ description: 'The new task, complete in itself.' }),
    }, { open: true }),
    replay: 'safe',
    execute: async ({ agent: name, task }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const recorded = registry?.calls?.[api.taskId];
      if (recorded !== undefined) return toolReply(recorded);
      const caller = whoIs(registry, api.conversationId);
      if (caller?.role !== 'root') return toolReply('Only Pi can delegate; use send_message.');
      const found = findAgent(agents, name);
      if (!found) return toolReply(noAgent(agents, name));
      const archived = archivedRefusal(agents, found.name);
      if (archived !== undefined) return oncePerCall(api, context, () => Promise.resolve(archived));
      if (!found.standing) return toolReply(`${found.name} is not a standing agent: give it the task with send_message, or spawn_agent a new agent under another name.`);
      const busy = `${found.name} is busy with its current task; send_message to steer it, or stop_agent first.`;
      const subsBusy = (names: readonly string[]) => `${found.name}'s current task is still running (its sub agent${names.length === 1
        ? ` ${names.join('')} is` : `s ${names.join(', ')} are`} busy); send_message to steer it, or stop_agent first.`;
      // Busy: a run in any of its sessions, or in a sub of its current one (the task goes on while its main is idle).
      const subs = subsOf(agents, found.name, found.conversationId);
      const [mainBusy, subsRunning] = await Promise.all([agentBusy(api, found, context),
        Promise.all(subs.map(([, sub]) => conversationBusy(api, sub.conversationId, context)))]);
      if (mainBusy) return oncePerCall(api, context, () => Promise.resolve(busy));
      const running = subs.filter((_, index) => subsRunning[index]).map(([each]) => each);
      if (running.length) return oncePerCall(api, context, () => Promise.resolve(subsBusy(running)));
      const preamble = initialContext
        ? await initialContext({ name: found.name, role: 'main', parent: PI, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${PI}] ${task}`;
      return oncePerCall(api, context, async (tx, draft) => {
        const agent = draft.agents[found.name];
        if (!agent?.standing) return `${found.name} is not a standing agent: give it the task with send_message, or spawn_agent a new agent under another name.`;
        if (agent.conversationId !== found.conversationId) return busy;
        // An input still on its way counts as work: to the current session (such as a delegate earlier in this turn, or
        // a send_message), or to one of its subs.
        const targets = await deliveryTargets(tx, draft.agents);
        if (targets.has(agent.conversationId)) return busy;
        const queued = subsOf(draft.agents, found.name, agent.conversationId).filter(([, sub]) => targets.has(sub.conversationId));
        if (queued.length) return subsBusy(queued.map(([each]) => each));
        // A session that holds nothing yet (never used, or its task's delivery ended before submitting) takes the task.
        const empty = (await tx.scanEntries({ conversationId: agent.conversationId }, 1)).items.length === 0;
        if (empty) agent.past ??= [];
        else {
          const previous = agent.conversationId;
          for (const each of Object.values(draft.agents)) {
            if (each.role === 'sub' && each.parent === found.name && each.session === undefined) each.session = previous;
          }
          const anchor = await tx.createTask(Anchor, null, { ...TASK_OPTIONS, conversationId: ROOT_CONVERSATION_ID });
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          agent.past = [...agent.past ?? [], previous];
          agent.conversationId = child.id;
        }
        // The first delegate can reuse the initial empty conversation; pin it too, never the standing identity.
        await onSpawn?.(tx, api.conversationId, agent.conversationId);
        await deriveAgent(tx, draft.agents, found.name, options);
        await createDelivery(tx, {
          to: found.name, conversationId: agent.conversationId, content, whenBusy: 'followUp', entry: { kind: MESSAGE_KIND, data: { from: PI, text: task } },
        }, { source: api.conversationId, owner: ROOT_CONVERSATION_ID });
        return `Delegated to ${found.name} (session ${agent.past.length + 1}). Its report will arrive as a message starting with [${found.name}].`;
      });
    },
  });
}

export function listAgentsTool(): ToolRegistration {
  return defineTool({
    name: 'list_agents',
    description: 'List all other agents: name, role (main/sub), parent, busy or idle, and a one-line last message.',
    parameters: obj({}, { open: true }),
    replay: 'safe',
    execute: async (_args, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return toolReply('This conversation is not an agent.');
      const others: { name: string; role: string; conversationId: ConversationId; past?: ConversationId[]; standing?: boolean }[] = [
        ...(caller.role === 'main' ? [{ name: PI, role: 'session agent', conversationId: ROOT_CONVERSATION_ID }] : []),
        ...Object.entries(agents).filter(([name]) => name !== caller.name && archivedSince(agents, name) === undefined)
          .map(([name, agent]) => ({ name, ...agent, role: `${agent.role}, parent ${agent.parent}${agent.standing ? ', standing' : ''}` })),
      ];
      if (!others.length) return toolReply('No other agents.');
      const [last, busy] = await Promise.all([api.commit(async (tx) => {
        const answers: Record<string, Answer | undefined> = {};
        for (const agent of others) answers[agent.name] = await agentAnswer(tx, agent);
        return answers;
      }, context), Promise.all(others.map((agent) => agentBusy(api, agent, context)))]);
      const lines = others.map((agent, index) => {
        const state = busy[index] ? 'busy' : 'idle';
        const answer = last[agent.name];
        const said = answer === undefined ? 'no message yet'
          : `last${answer.session === undefined ? '' : ` (session ${answer.session})`}: ${brief(answer.text)}`;
        return `- ${agent.name} (${agent.role}) ${state} — ${said}`;
      });
      return toolReply(lines.join('\n'));
    },
  });
}

export function sendMessageTool(deps: ToolDeps): ToolRegistration {
  const { roster, createDelivery } = deps;
  return defineTool({
    name: 'send_message',
    description: 'Send `text` to another agent by name. Main agents may also send to "Pi", the session agent; sub agents may not. '
      + 'An agent without coding tools may send only to Pi and its own sub agents, and its subs only to it and each other. '
      + 'A busy agent sees it between its tool calls; an idle one starts working on it. Returns at once: never wait for a reply.',
    parameters: obj({
      to: str({ description: 'Agent name, or "Pi" (main agents only).' }),
      text: str(),
    }, { open: true }),
    replay: 'safe',
    execute: async ({ to, text: message }, api, context) => {
      const caller = await callerOf(api, context);
      if (!caller) return toolReply('This conversation is not an agent.');
      return oncePerCall(api, context, async (tx, registry) => {
        const found = addressee(registry, caller, to);
        if ('error' in found) return found.error;
        if (found.name === caller.name) return 'You cannot message yourself.';
        const archived = found.role === 'root' ? undefined : archivedRefusal(registry.agents, found.name);
        if (archived !== undefined) return archived;
        const refused = messageRefusal(registry.agents, roster, caller, found.name);
        if (refused !== undefined) return refused;
        if (caller.role === 'sub' && caller.session !== undefined && found.name === caller.parent && caller.session !== found.conversationId) {
          return `${found.name} has moved on to a new task; the one you worked for is over.`;
        }
        // A standing agent's current session that messages a sub of an earlier one takes it on: its reports come here.
        const sub = registry.agents[found.name];
        if (sub?.session !== undefined && sub.parent === caller.name && api.conversationId === registry.agents[caller.name]?.conversationId) {
          sub.session = api.conversationId;
        }
        // Any other caller would wake a sub whose report reaches no one; only the session it works for still hears it.
        if (sub && staleSub(registry.agents, sub) && sub.session !== api.conversationId) {
          return `${found.name} worked for an earlier task of ${sub.parent}, which is over: its report would reach no one. `
            + `${sub.parent} can take it on by messaging it.`;
        }
        // A main agent's message to Pi names the session it came from, as its reports do.
        const session = found.role === 'root' && caller.role === 'main' ? sessionNumber(caller, api.conversationId) : undefined;
        const entry: MessageEntry | ReportEntry = found.role === 'root'
          ? { kind: REPORT_KIND, data: { name: caller.name, text: message, ...session === undefined ? {} : { session } } }
          : { kind: MESSAGE_KIND, data: { from: caller.name, text: message } };
        const content = found.role === 'root' ? piReportText(caller.name, message, session) : `[from ${caller.name}] ${message}`;
        await createDelivery(tx, { to: found.name, conversationId: found.conversationId, content, entry, whenBusy: 'steer' }, { source: api.conversationId });
        return `Sent to ${found.name}.`;
      });
    },
  });
}

export function lastMessageTool(): ToolRegistration {
  return defineTool({
    name: 'last_message',
    description: 'Get an agent\'s latest reply and whether it is busy. Main agents may also ask for "Pi"; sub agents may not.',
    parameters: obj({ name: str() }, { open: true }),
    replay: 'safe',
    execute: async ({ name }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return toolReply('This conversation is not an agent.');
      const found = addressee(registry, caller, name);
      if ('error' in found) return toolReply(found.error);
      const archived = found.role === 'root' ? undefined : archivedRefusal(agents, found.name);
      if (archived !== undefined) return toolReply(archived);
      const [said, busy] = await Promise.all([api.commit((tx) => agentAnswer(tx, found), context), agentBusy(api, found, context)]);
      const state = busy ? 'busy' : 'idle';
      const from = said?.session === undefined ? '' : ` (session ${said.session}, an earlier task)`;
      return toolReply(`${found.name} is ${state}. ${said === undefined ? 'No message yet.' : `Last message${from}:\n${said.text}`}`);
    },
  });
}

export function stopAgentTool(): ToolRegistration {
  return defineTool({
    name: 'stop_agent',
    description: 'Stop an agent\'s current work and drop its queued messages; stopping a main agent also stops its sub agents. '
      + 'Stopped agents stay and can be messaged again. Pi may stop any agent; a main agent only its own sub agents.',
    parameters: obj({ name: str() }, { open: true }),
    // A rerun after a crash could stop newer work.
    replay: 'unsafe',
    execute: async ({ name }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      const found = findAgent(agents, name);
      if (!caller || caller.role === 'sub') return toolReply('Sub agents cannot stop agents.');
      if (!found) return toolReply(noAgent(agents, name));
      const archived = archivedRefusal(agents, found.name);
      if (archived !== undefined) return toolReply(archived);
      if (caller.role === 'main' && found.parent !== caller.name) return toolReply(`${found.name} is not your sub agent.`);
      const subs = (await stopAgents(api, context, found.name)).slice(0, -1);
      const also = subs.length ? ` and its sub agents ${subs.join(', ')}` : '';
      const untold = found.parent === caller.name ? '' : ` Its main agent ${found.parent} is not told; message it if it should know.`;
      return toolReply(`Stopped ${found.name}${also}.${untold}`);
    },
  });
}

export function deleteAgentTool(deps: ToolDeps): ToolRegistration {
  const { roster } = deps;
  return defineTool({
    name: 'delete_agent',
    description: 'Delete an agent you no longer need, with its sub agents, so it leaves list_agents and takes no more work. '
      + 'Pi only. Refused for standing agents, and while the agent or one of its sub agents is busy or has a message on its way: '
      + 'stop_agent it first. Its chat stays readable with zoom("Name"), and the name is free again.',
    parameters: obj({ name: str() }, { open: true }),
    replay: 'safe',
    execute: async ({ name }, api, context) => {
      const caller = await callerOf(api, context);
      if (caller?.role !== 'root') return toolReply('Only Pi can delete agents.');
      const busy = await busyNames(api, context);
      return oncePerCall(api, context, async (tx, registry) => deleteText(await removeAgent(tx, registry, name, busy, roster)));
    },
  });
}

// Tool-level guard, before a call's intent is recorded: what a role may not do never runs.
export function agentsGuard(roster: Roster) {
  return hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (!['spawn_agent', 'stop_agent', 'send_message', 'last_message', 'delegate', 'delete_agent'].includes(call.name)) return undefined;
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (call.name === 'delegate') return caller?.role === 'root' ? undefined : { block: 'Only Pi can delegate; use send_message.' };
      if (call.name === 'delete_agent') return caller?.role === 'root' ? undefined : { block: 'Only Pi can delete agents.' };
      if (call.name === 'send_message' && caller) {
        const to = String(call.arguments?.to);
        const name = to.toLowerCase() === PI.toLowerCase() ? PI : findAgent(agents, to)?.name;
        const refused = name === undefined || name === caller.name ? undefined : messageRefusal(agents, roster, caller, name);
        if (refused !== undefined) return { block: refused };
      }
      if (caller?.role !== 'sub') return undefined;
      if (call.name === 'spawn_agent' || call.name === 'stop_agent') return { block: `Sub agents cannot use ${call.name}.` };
      const addressed = call.name === 'send_message' ? call.arguments?.to : call.arguments?.name;
      if (String(addressed).toLowerCase() === PI.toLowerCase()) {
        return { block: 'Sub agents cannot address Pi; message your main agent instead.' };
      }
      return undefined;
    },
  });
}
