// The agents' registry (AgentsDoc: every agent's role, parent and conversations, and the calls already answered), the
// Anchor task that owns agents' conversations, and the lookups every part of src/agents/ shares. Persisted names here
// (the doc and task kinds) are frozen.
import type { Context } from '@earendil-works/chord';
import { LiveDoc, ROOT_CONVERSATION_ID, defineDoc, defineTask } from '@earendil-works/pi-durable';
import type { ConversationId, Cursor, DocumentReader, EntryId, Session, TaskId, TaskOptions, ToolExecutionResult, Tx } from '@earendil-works/pi-durable';
import type { Roster, StandingAgent } from './roster.ts';
import { rosterEntry } from './roster.ts';
import type { MESSAGE_KIND, REPORT_KIND} from './entries.ts';
import { assistantText } from './entries.ts';

export const PI = 'Pi';

export const KEEP_CALLS = 256;

export const KEEP_REPORTED = 32;

/**
 * An input reaching Pi from agent `name`, in upstream UniiChat's report format (Call.ts `report_text`, Apache-2.0):
 * the name, the text, and where Pi reads the agent's whole chat. Agents cannot zoom, so their inputs stay `[Name] text`.
 * `session` (from 1) is the session of a standing agent the input came from: its link names it (`zoom("Name#n")`), so it
 * still opens that session after a later delegate.
 */
export const piReportText = (name: string, text: string, session?: number): string =>
  `[${name}]\n${text}\n\nFull chat: zoom("${name}${session === undefined ? '' : `#${session}`}")`;

export type AgentRole = 'main' | 'sub';

/**
 * A registry entry. `parent` is "Pi" or a main agent's name; `reported` holds answers already reported. `standing` marks
 * a main agent of the roster (ADR 0027); absent on every other agent, and cleared when it leaves the roster. A standing
 * agent's `conversationId` is its current session; `delegate` keeps the ones before it in `past`, oldest first. A sub of
 * a standing agent holds the session it works for in `session`: its reports reach its main agent only while that is
 * the current one.
 */
export type AgentRecord = {
  conversationId: ConversationId; role: AgentRole; parent: string; reported: EntryId[];
  standing?: boolean; past?: ConversationId[]; session?: ConversationId;
  /** When the user archived it (ms since the epoch, ADR 0034); absent on every other agent. */
  archivedAt?: number;
};

/**
 * `calls` maps a tool task ID to the result its first run returned. `deleted` maps the name of each agent removed with
 * `delete_agent` to its conversations, oldest first, so `zoom("Name")` still reads its chat; absent until the first one.
 */
export type AgentsState = { agents: Record<string, AgentRecord>; calls: Record<string, string>; deleted?: Record<string, ConversationId[]> };

/** An agent's input entry: a message from another agent, or a report to its parent (`id` once placed). */
export type MessageEntry = { kind: typeof MESSAGE_KIND; data: { from: string; text: string } };

/** `session`: the standing agent's session (from 1) a report to Pi came from, for its link (see `piReportText`). */
export type ReportEntry = { kind: typeof REPORT_KIND; data: { name: string; text: string; session?: number } };

/** An input that reached Pi; `id` is its delivery task's ID, `session` the standing agent's session it came from. */
export type AgentReport = { name: string; text: string; id: TaskId; session?: number };

/** One row of `listAgents()`. */
export interface AgentInfo {
  readonly name: string;
  readonly role: AgentRole;
  readonly parent: string;
  readonly conversationId: ConversationId;
  readonly busy: boolean;
  /** A standing agent of the roster. */
  readonly standing: boolean;
  /** When it was archived, its main agent's time for a sub archived with it (see `archivedSince`); absent when not. */
  readonly archivedAt?: number;
}

/** The Harness or a tool's api: anything with `snapshot()` and `commit(tx => …)`. */
export type AgentsSource = DocumentReader & Pick<Session, 'commit'>;

export type Named = AgentRecord & { name: string };

export type Caller = Named | { name: typeof PI; role: 'root'; conversationId: ConversationId };

/** Session-wide registry: name → { conversationId, role: 'main'|'sub', parent: 'Pi'|main name, reported }. */
export const AgentsDoc = defineDoc<AgentsState>({
  kind: 'agents.registry',
  version: 1,
  scope: 'session',
  initial: () => ({ agents: {}, calls: {} }),
  // Every tool call writes a delta (`calls` keeps the newest KEEP_CALLS): a base now and then keeps a reopen short.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export const toolReply = (value: string): ToolExecutionResult => ({ output: [{ type: 'text', text: value }] });

export const brief = (value: string, max = 120) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const findAgent = (agents: Readonly<Record<string, AgentRecord>>, name: string): Named | undefined => {
  const found = Object.entries(agents).find(([each]) => each.toLowerCase() === String(name).toLowerCase());
  return found && { name: found[0], ...found[1] };
};

/** The refusal for an unknown agent name, naming the agents there are, so a misspelt name is fixed in one step. */
export const noAgent = (agents: Readonly<Record<string, AgentRecord>>, name: string): string => {
  // Archived agents are hidden everywhere else (ADR 0034), so not named here either.
  const names = Object.keys(agents).filter((each) => archivedSince(agents, each) === undefined);
  return `No agent named ${name}. ${names.length ? `The agents are ${names.join(', ')}.` : 'There are none.'}`;
};

/** How long an archived agent is kept before `purgeArchived()` deletes it: a day (ADR 0034). */
export const ARCHIVE_TTL_MS = 86_400_000;

/**
 * Since when agent `name` counts as archived: its own `archivedAt`, or its main agent's when that is archived, the
 * earlier of the two; undefined while neither is. A sub of an archived main counts as archived.
 */
export function archivedSince(agents: Readonly<Record<string, AgentRecord>>, name: string): number | undefined {
  const agent = agents[name];
  if (!agent) return undefined;
  const main = agent.role === 'sub' ? agents[agent.parent]?.archivedAt : undefined;
  const times = [agent.archivedAt, main].filter((each) => each !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/** The refusal for an archived agent: when it is deleted. */
export const archivedText = (name: string, since: number) =>
  `${name} is archived; it is deleted at ${new Date(since + ARCHIVE_TTL_MS).toISOString()}.`;

/** The refusal text when agent `name` (a registry spelling) is archived, else undefined. */
export function archivedRefusal(agents: Readonly<Record<string, AgentRecord>>, name: string): string | undefined {
  const since = archivedSince(agents, name);
  return since === undefined ? undefined : archivedText(name, since);
}

/** Who the conversation is: Pi, a registered agent (any of a standing agent's sessions), or undefined for any other. */
export function whoIs(registry: Readonly<AgentsState> | undefined, conversationId: ConversationId): Caller | undefined {
  if (conversationId === ROOT_CONVERSATION_ID) return { name: PI, role: 'root', conversationId };
  for (const [name, agent] of Object.entries(registry?.agents ?? {})) {
    if (agent.conversationId === conversationId || agent.past?.includes(conversationId)) return { name, ...agent };
  }
  return undefined;
}

/** Resolve a target; `Pi` only for those who may address it. */
export function addressee(registry: Readonly<AgentsState> | undefined, me: Caller, name: string): Caller | { error: string } {
  if (String(name).toLowerCase() === PI.toLowerCase()) {
    if (me.role === 'sub') return { error: 'Sub agents cannot address Pi; message your main agent instead.' };
    return { name: PI, role: 'root', conversationId: ROOT_CONVERSATION_ID };
  }
  // Only Pi gets the list: an agent that web content may steer has no use for names it cannot address.
  const agents = registry?.agents ?? {};
  return findAgent(agents, name) ?? { error: me.role === 'root' ? noAgent(agents, name) : `No agent named ${name}.` };
}

/** Latest committed assistant text of one conversation, read through a transaction; see `agentAnswer` for an agent's. */
export async function conversationAnswer(tx: Tx, conversationId: ConversationId): Promise<string | undefined> {
  let cursor: Cursor | undefined;
  for (let pages = 0; pages < 8; pages++) {
    const page = await tx.scanEntries({ conversationId }, 64, cursor);
    for (const entry of page.items) {
      if (entry.kind === 'pi.assistant' && assistantText(entry)) return assistantText(entry);
    }
    if ((cursor = page.next) === undefined) break;
  }
  return undefined;
}

/** The latest answer of an agent: its current session's, else its newest past session's that has one (then `session`). */
export type Answer = { text: string; session?: number };

export async function agentAnswer(tx: Tx, agent: Pick<AgentRecord, 'conversationId' | 'past'>): Promise<Answer | undefined> {
  const sessions = [...agent.past ?? [], agent.conversationId];
  for (let index = sessions.length - 1; index >= 0; index--) {
    const id = sessions[index];
    const text = id === undefined ? undefined : await conversationAnswer(tx, id);
    if (text !== undefined) return index === sessions.length - 1 ? { text } : { text, session: index + 1 };
  }
  return undefined;
}

/** Whether one conversation has a run; see `agentBusy` for an agent's every session. */
export const conversationBusy = async (source: DocumentReader, conversationId: ConversationId, context: Context) =>
  (await source.snapshot(LiveDoc, conversationId, context))?.run !== undefined;

/** Every conversation of an agent: a standing agent's past sessions, oldest first, then its current one. */
export const sessionsOf = (agent: Pick<AgentRecord, 'conversationId' | 'past'>): ConversationId[] => [...agent.past ?? [], agent.conversationId];

/** Whether any of an agent's conversations has a run: a past session can still run (input that reached it before). */
export async function agentBusy(source: DocumentReader, agent: Pick<AgentRecord, 'conversationId' | 'past'>, context: Context): Promise<boolean> {
  return (await Promise.all(sessionsOf(agent).map((id) => conversationBusy(source, id, context)))).includes(true);
}

/** The subs of standing agent `main`'s session `current`: those that work for it, or for no session yet. */
export const subsOf = (agents: Readonly<Record<string, AgentRecord>>, main: string, current: ConversationId): [string, AgentRecord][] =>
  Object.entries(agents).filter(([, agent]) => agent.role === 'sub' && agent.parent === main
    && (agent.session === undefined || agent.session === current));

/** Which session (from 1) of a standing agent (or one with past sessions) `conversationId` is; undefined for others. */
export function sessionNumber(agent: Pick<AgentRecord, 'conversationId' | 'past' | 'standing'>, conversationId: ConversationId): number | undefined {
  if (!agent.standing && !agent.past?.length) return undefined;
  const index = sessionsOf(agent).indexOf(conversationId);
  return index < 0 ? undefined : index + 1;
}

/** A sub of a standing agent's earlier session: its reports reach no one (see Deliver). */
export const staleSub = (agents: Readonly<Record<string, AgentRecord>>, agent: AgentRecord): boolean =>
  agent.session !== undefined && agent.session !== agents[agent.parent]?.conversationId;

// Owner of an agent's conversation: finishes at once; background, so Pi's Esc never reaches it.
export const Anchor = defineTask<null, { phase: 'done' }, null>({
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

export const TASK_OPTIONS: TaskOptions = { ownership: { kind: 'conversation' }, background: true };

/** The roster entry whose choices agent `name` takes: its own for a standing main, its main's for a sub of one. */
export function standingOf(agents: Readonly<Record<string, AgentRecord>>, name: string, roster: Roster | undefined): StandingAgent | undefined {
  const agent = agents[name];
  if (!agent || !roster) return undefined;
  const main = agent.role === 'main' ? name : agent.parent;
  return agents[main]?.standing ? rosterEntry(roster, main) : undefined;
}

/**
 * Whether agent `name` is held to its own team: a standing agent without the `coding` kit, or a sub of one. Such an
 * agent reads untrusted text (web pages) or has no way to act on it, so it must not relay orders to agents with bash.
 */
export const confined = (agents: Readonly<Record<string, AgentRecord>>, name: string, roster: Roster): boolean => {
  const entry = standingOf(agents, name, roster);
  return entry !== undefined && !entry.tools.includes('coding');
};

/**
 * Why `caller` may not send_message agent `to` (a registry name, or "Pi"), or undefined when it may. A confined main
 * agent may message Pi and its own sub agents; its subs, their main agent and its other subs. Pi and every other agent
 * keep the general rules.
 */
export function messageRefusal(agents: Readonly<Record<string, AgentRecord>>, roster: Roster, caller: Caller, to: string): string | undefined {
  // A sub addressing Pi is refused for every sub, with its own text (see `target`).
  if (caller.role === 'root' || (caller.role === 'sub' && to === PI) || !confined(agents, caller.name, roster)) return undefined;
  const main = caller.role === 'main' ? caller.name : caller.parent;
  const target = agents[to];
  if (caller.role === 'main' ? to === PI : to === main) return undefined;
  if (target?.role === 'sub' && target.parent === main) return undefined;
  return caller.role === 'main'
    ? `${caller.name} cannot message ${to}: agents without coding tools may message only Pi and their own sub agents.`
    : `${caller.name} cannot message ${to}: sub agents of an agent without coding tools may message only their main agent and its other sub agents.`;
}

/** Anything that opens a conversation to abort it: the Harness or a tool's `api`. */
export type AgentsStopper = DocumentReader & {
  conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<void> } | undefined>;
};

/** A deleted agent's kept conversations, as a record `agentTranscript` reads; undefined if no such name was deleted. */
export function deletedAgent(registry: Readonly<AgentsState> | undefined, name: string) {
  const found = Object.entries(registry?.deleted ?? {}).find(([each]) => each.toLowerCase() === String(name).toLowerCase());
  const sessions = found?.[1] ?? [];
  const current = sessions.at(-1);
  return found && current !== undefined ? { name: found[0], conversationId: current, past: sessions.slice(0, -1), standing: false } : undefined;
}

/** The names of the agents with a run in any of their conversations. */
export const busyNames = async (source: DocumentReader, context: Context): Promise<Set<string>> =>
  new Set((await listAgents(source, context, { includeArchived: true })).filter((agent) => agent.busy).map((agent) => agent.name));

/**
 * Every spawned agent with its role, parent, conversation, busy state (a run in any of its conversations) and, when
 * archived, since when. Archived agents are left out unless `includeArchived`.
 */
export async function listAgents(source: DocumentReader, context: Context,
  options: { readonly includeArchived?: boolean } = {}): Promise<AgentInfo[]> {
  const agents = (await source.snapshot(AgentsDoc, context))?.agents ?? {};
  const rows = Object.entries(agents).map(([name, agent]) => ({ name, agent, archivedAt: archivedSince(agents, name) }))
    .filter((row) => options.includeArchived === true || row.archivedAt === undefined);
  return Promise.all(rows.map(async ({ name, agent, archivedAt }) => ({
    name, role: agent.role, parent: agent.parent, conversationId: agent.conversationId,
    busy: await agentBusy(source, agent, context), standing: agent.standing === true,
    ...archivedAt === undefined ? {} : { archivedAt },
  })));
}
