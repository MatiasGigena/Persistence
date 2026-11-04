import { type Context, copyJson, type Draft } from '@earendil-works/chord';
import { type ImageContent, type Message, type TextContent, type ThinkingContent, type ToolCall } from '@earendil-works/pi-ai';
import {
  AgentDoc, AssistantEntry, configure, defineDoc, defineTask, defineTool,
  hook, LiveDoc, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import type {
  AgentChange, ConversationId, Cursor, DocumentReader, EntryId, EntryRecord, Extension, NextTaskState,
  Session, SettledSubmissionRecord, TaskId, TaskOptions, TaskRuntime, ToolExecutionApi, ToolExecutionResult, ToolRegistration, Tx,
} from '@earendil-works/pi-durable';
import {
  AUTOREVIEW_POLICY, isAgentName, type Kit, LOCAL_KITS, PURPOSES, type Roster, rosterEntry, type StandingAgent,
} from './roster.ts';
import { agentInputOf, MESSAGE_KIND, REPORT_KIND } from './entries.ts';
import { NotFound } from '../ui/errors.ts';
import type { ArchiveTarget } from '../ui/types.ts';

export { AGENT_NAME, DEFAULT_ROSTER, isAgentName, isKit, KITS, LOCAL_KITS } from './roster.ts';
export { agentInputOf, MESSAGE_KIND, REPORT_KIND } from './entries.ts';
export type { AgentInput } from './entries.ts';
export type { Kit, Roster, StandingAgent } from './roster.ts';

/**
 * Multi-agent messaging for the one UniiChat chat (Pi = the root conversation).
 *
 *   Pi ─┬─ main agent ─┬─ sub agent       Pi spawns mains, mains spawn subs, subs cannot spawn.
 *       │              └─ sub agent       Everyone lists, messages, and reads the last message of
 *       └─ main agent ── sub agent        every agent; only mains (and Pi) address "Pi". A standing agent
 *                                         without coding tools, and its subs, message only within their team.
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
 *   const Agents = createAgentsExtension({ initialContext, roster, onSpawn, onDelivery });
 *   registry.install(Agents);                       // also on inspect-only launches: tasks stay known
 *   agent.extensions = [CodingTools, Agents, ...];  // the root's array selects exactly these
 *   agent.tools = [...(allowTools ? CodingTools.tools : []), ...Agents.tools];  // an array enables exactly these
 *   await root.configure(agent, context);
 *   await syncAgents(harness, context, { childAgent, roster, kits });  // every work launch, after root.configure()
 *   harness.resume();                               // on work launches, so pending deliveries continue
 * Pi is always ROOT_CONVERSATION_ID; nothing else needs configuring and no settings are required.
 * Every input reaching Pi (a main agent's final report or its send_message) is the user message
 * `piReportText(name, text)`, placed as the entry `{ kind: 'agents.report', data: { name, text, id } }`; inputs to
 * other agents are `agents.message` (`[from Name] text`, data `{ from, text }`) or `agents.report`.
 * Pi's answers to them are ordinary root runs that no `submission.wait()` of the host awaits, so a
 * host that prints answers must watch the root. Deliveries are background tasks: `root.waitForIdle()`
 * and Pi's Esc (`root.abort()`) do not reach them; `root.abort(ctx, { background: true })` does.
 */

export const PI = 'Pi';
const KEEP_CALLS = 256;
const KEEP_REPORTED = 32;
/**
 * An input reaching Pi from agent `name`, in upstream UniiChat's report format (Call.ts `report_text`, Apache-2.0):
 * the name, the text, and where Pi reads the agent's whole chat. Agents cannot zoom, so their inputs stay `[Name] text`.
 * `session` (from 1) is the session of a standing agent the input came from: its link names it (`zoom("Name#n")`), so it
 * still opens that session after a later delegate.
 */
export const piReportText = (name: string, text: string, session?: number): string =>
  `[${name}]\n${text}\n\nFull chat: zoom("${name}${session === undefined ? '' : `#${session}`}")`;
/** The most characters of an agent's chat that one zoom("Name") page holds (upstream UniiChat Clip.ts CAP). */
export const TRANSCRIPT_PAGE = 30_000;

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

type Named = AgentRecord & { name: string };
type Caller = Named | { name: typeof PI; role: 'root'; conversationId: ConversationId };
type Block = TextContent | ImageContent | ThinkingContent | ToolCall;
type DeliverState = { phase: 'deliver' };
type DeliveryInput = {
  to: string;
  conversationId: ConversationId;
  content: string;
  entry: MessageEntry | ReportEntry;
  whenBusy: 'steer' | 'followUp';
};

/** Session-wide registry: name → { conversationId, role: 'main'|'sub', parent: 'Pi'|main name, reported }. */
export const AgentsDoc = defineDoc<AgentsState>({
  kind: 'agents.registry',
  version: 1,
  scope: 'session',
  initial: () => ({ agents: {}, calls: {} }),
  // Every tool call writes a delta (`calls` keeps the newest KEEP_CALLS): a base now and then keeps a reopen short.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

const text = (content: string | readonly Block[] | undefined) => typeof content === 'string' ? content
  : (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
const assistantText = (entry: { readonly model?: readonly Message[] } | undefined) => (entry?.model ?? [])
  .filter((message) => message.role === 'assistant').map((message) => text(message.content)).join('');
const reply = (value: string): ToolExecutionResult => ({ output: [{ type: 'text', text: value }] });
const brief = (value: string, max = 120) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const find = (agents: Readonly<Record<string, AgentRecord>>, name: string): Named | undefined => {
  const found = Object.entries(agents).find(([each]) => each.toLowerCase() === String(name).toLowerCase());
  return found && { name: found[0], ...found[1] };
};

/** The refusal for an unknown agent name, naming the agents there are, so a misspelt name is fixed in one step. */
const noAgent = (agents: Readonly<Record<string, AgentRecord>>, name: string): string => {
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
function archivedSince(agents: Readonly<Record<string, AgentRecord>>, name: string): number | undefined {
  const agent = agents[name];
  if (!agent) return undefined;
  const main = agent.role === 'sub' ? agents[agent.parent]?.archivedAt : undefined;
  const times = [agent.archivedAt, main].filter((each) => each !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/** The refusal for an archived agent: when it is deleted. */
const archivedText = (name: string, since: number) =>
  `${name} is archived; it is deleted at ${new Date(since + ARCHIVE_TTL_MS).toISOString()}.`;

/** The refusal text when agent `name` (a registry spelling) is archived, else undefined. */
function archivedRefusal(agents: Readonly<Record<string, AgentRecord>>, name: string): string | undefined {
  const since = archivedSince(agents, name);
  return since === undefined ? undefined : archivedText(name, since);
}

/** Who the conversation is: Pi, a registered agent (any of a standing agent's sessions), or undefined for any other. */
function whoIs(registry: Readonly<AgentsState> | undefined, conversationId: ConversationId): Caller | undefined {
  if (conversationId === ROOT_CONVERSATION_ID) return { name: PI, role: 'root', conversationId };
  for (const [name, agent] of Object.entries(registry?.agents ?? {})) {
    if (agent.conversationId === conversationId || agent.past?.includes(conversationId)) return { name, ...agent };
  }
  return undefined;
}

/** Resolve a target; `Pi` only for those who may address it. */
function target(registry: Readonly<AgentsState> | undefined, me: Caller, name: string): Caller | { error: string } {
  if (String(name).toLowerCase() === PI.toLowerCase()) {
    if (me.role === 'sub') return { error: 'Sub agents cannot address Pi; message your main agent instead.' };
    return { name: PI, role: 'root', conversationId: ROOT_CONVERSATION_ID };
  }
  // Only Pi gets the list: an agent that web content may steer has no use for names it cannot address.
  const agents = registry?.agents ?? {};
  return find(agents, name) ?? { error: me.role === 'root' ? noAgent(agents, name) : `No agent named ${name}.` };
}

/** Latest committed assistant text of one conversation, read through a transaction; see `agentAnswer` for an agent's. */
async function conversationAnswer(tx: Tx, conversationId: ConversationId): Promise<string | undefined> {
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
type Answer = { text: string; session?: number };
async function agentAnswer(tx: Tx, agent: Pick<AgentRecord, 'conversationId' | 'past'>): Promise<Answer | undefined> {
  const sessions = [...agent.past ?? [], agent.conversationId];
  for (let index = sessions.length - 1; index >= 0; index--) {
    const id = sessions[index];
    const text = id === undefined ? undefined : await conversationAnswer(tx, id);
    if (text !== undefined) return index === sessions.length - 1 ? { text } : { text, session: index + 1 };
  }
  return undefined;
}

/** Whether one conversation has a run; see `agentBusy` for an agent's every session. */
const conversationBusy = async (source: DocumentReader, conversationId: ConversationId, context: Context) =>
  (await source.snapshot(LiveDoc, conversationId, context))?.run !== undefined;
/** Every conversation of an agent: a standing agent's past sessions, oldest first, then its current one. */
const sessionsOf = (agent: Pick<AgentRecord, 'conversationId' | 'past'>): ConversationId[] => [...agent.past ?? [], agent.conversationId];
/** Whether any of an agent's conversations has a run: a past session can still run (input that reached it before). */
async function agentBusy(source: DocumentReader, agent: Pick<AgentRecord, 'conversationId' | 'past'>, context: Context): Promise<boolean> {
  return (await Promise.all(sessionsOf(agent).map((id) => conversationBusy(source, id, context)))).includes(true);
}

const DELIVER_KIND = 'agents.deliver';
/** The memo of an `agents.deliver` task that fixes where its message goes once it was redirected (see Deliver). */
const SESSION_MEMO = 'session';
/**
 * The conversations an unfinished `agents.deliver` task still carries an input to (its redirected session, else its
 * input's), read in the commit of `tx`. A delivery stays unfinished until its input was answered. One bound for a past
 * session of an agent in `agents` that has not chosen yet counts for that agent's current session too: Deliver may
 * redirect it there, and the choice is kept only after its commit.
 */
async function deliveryTargets(tx: Tx, agents: Readonly<Record<string, AgentRecord>>): Promise<ReadonlySet<unknown>> {
  const targets = new Set<unknown>();
  for (const status of ['pending', 'running', 'waiting'] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ kind: DELIVER_KIND, status }, 64, cursor);
      for (const task of page.items) {
        const input = typeof task.input === 'object' && task.input !== null && !Array.isArray(task.input) ? task.input : undefined;
        const memo = task.memos?.[SESSION_MEMO];
        const to = memo ?? input?.conversationId;
        if (to !== undefined) targets.add(to);
        const agent = memo === undefined && typeof input?.to === 'string' ? agents[input.to] : undefined;
        if (agent?.past?.some((id) => id === input?.conversationId)) targets.add(agent.conversationId);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return targets;
}

/** The subs of standing agent `main`'s session `current`: those that work for it, or for no session yet. */
const subsOf = (agents: Readonly<Record<string, AgentRecord>>, main: string, current: ConversationId): [string, AgentRecord][] =>
  Object.entries(agents).filter(([, agent]) => agent.role === 'sub' && agent.parent === main
    && (agent.session === undefined || agent.session === current));

/** Which session (from 1) of a standing agent (or one with past sessions) `conversationId` is; undefined for others. */
function sessionNumber(agent: Pick<AgentRecord, 'conversationId' | 'past' | 'standing'>, conversationId: ConversationId): number | undefined {
  if (!agent.standing && !agent.past?.length) return undefined;
  const index = sessionsOf(agent).indexOf(conversationId);
  return index < 0 ? undefined : index + 1;
}

/** A sub of a standing agent's earlier session: its reports reach no one (see Deliver). */
const staleSub = (agents: Readonly<Record<string, AgentRecord>>, agent: AgentRecord): boolean =>
  agent.session !== undefined && agent.session !== agents[agent.parent]?.conversationId;

// Owner of an agent's conversation: finishes at once; background, so Pi's Esc never reaches it.
const Anchor = defineTask<null, { phase: 'done' }, null>({
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

/** A tool kit: the tools a standing agent gets for it, and the extension that holds them when Pi's do not. */
export interface ToolKit {
  /** Selected for the agents that have the kit; the host must also `registry.install` it. */
  readonly extension?: Extension;
  readonly tools: readonly ToolRegistration[];
}
/** The kits this host has; a kit left out gives its agents none of its tools. */
export type ToolKits = Readonly<Partial<Record<Kit, ToolKit>>>;

/** How agents are derived from Pi: the host's `childAgent` change, the roster, and the tool kits. */
export interface AgentsSetup {
  /** Applied to every spawned agent after it copies Pi's choices. */
  readonly childAgent?: AgentChange;
  /** The standing agents (ADR 0027); none without it. */
  readonly roster?: Roster;
  readonly kits?: ToolKits;
}

/** The agent tools' names (persisted, frozen); a standing agent gets them besides its kits. */
const AGENT_TOOLS = ['spawn_agent', 'list_agents', 'send_message', 'last_message', 'stop_agent'];
const SUB_HIDDEN = ['spawn_agent', 'stop_agent'];
/** Pi's alone: agents copy Pi's tools, then lose these. */
const PI_ONLY = ['delegate', 'delete_agent'];
const TASK_OPTIONS: TaskOptions = { ownership: { kind: 'conversation' }, background: true };

/** The roster entry whose choices agent `name` takes: its own for a standing main, its main's for a sub of one. */
function standingOf(agents: Readonly<Record<string, AgentRecord>>, name: string, roster: Roster | undefined): StandingAgent | undefined {
  const agent = agents[name];
  if (!agent || !roster) return undefined;
  const main = agent.role === 'main' ? name : agent.parent;
  return agents[main]?.standing ? rosterEntry(roster, main) : undefined;
}

/**
 * Whether agent `name` is held to its own team: a standing agent without the `coding` kit, or a sub of one. Such an
 * agent reads untrusted text (web pages) or has no way to act on it, so it must not relay orders to agents with bash.
 */
const confined = (agents: Readonly<Record<string, AgentRecord>>, name: string, roster: Roster): boolean => {
  const entry = standingOf(agents, name, roster);
  return entry !== undefined && !entry.tools.includes('coding');
};

/**
 * Why `caller` may not send_message agent `to` (a registry name, or "Pi"), or undefined when it may. A confined main
 * agent may message Pi and its own sub agents; its subs, their main agent and its other subs. Pi and every other agent
 * keep the general rules.
 */
function messageRefusal(agents: Readonly<Record<string, AgentRecord>>, roster: Roster, caller: Caller, to: string): string | undefined {
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

/** The local tools' safety note, as in Pi's instructions (src/runtime/runtime.ts `piInstructions`). */
const protectedText = (bash: boolean, routed = false) => `These tools act on ${routed ? 'the pinned machine with its runner permissions' : 'the local machine with the host process permissions'}. Some folders are `
  + 'protected: this chat\'s own state and the user\'s credentials (~/.ssh, ~/.claude, cloud and git logins) cannot be read or changed, the user\'s SSH '
  + `agent is not reachable, and system folders (/etc, /usr, ...) are read-only${bash ? '; bash runs in a sandbox that enforces this' : ''}. A refusal that names a `
  + 'protected path is deliberate: do not try to get around it, and say in your report if the task needs that path. Use the tools '
  + 'only when your task needs them, and do nothing destructive or otherwise sensitive that it does not ask for.';

/**
 * A standing agent's (and its subs') instructions: Pi's, with its line about Pi's coding tools (the one naming bash) replaced
 * by the agent's own tools. `tools` are its kits' tools in force; `local` those of its local kits, `localOn` whether
 * they are on. Pi's instructions name read, write, edit and bash, which an agent without the coding kit must not call.
 */
function standingInstructions(pi: string | undefined, tools: readonly string[], local: readonly string[], localOn: boolean): string {
  const kept = (pi ?? '').split('\n').filter((line) => line && !/\bbash\b/.test(line));
  const own = tools.length ? `Your tools besides the agent tools: ${tools.join(', ')}. You have no others.`
    : 'You have no tools besides the agent tools.';
  const lines = [...kept, own];
  const usable = localOn ? local : [];
  if (usable.length) lines.push(protectedText(usable.includes('bash'), (pi ?? '').includes('Your machine and working directory are pinned per run')));
  if (!localOn && local.length) {
    lines.push(`Your local tools (${local.join(', ')}) are off for this launch; only the user can turn them on.`);
  }
  if (!usable.includes('bash')) {
    lines.push(usable.includes('autoreview') ? 'You cannot change files or run arbitrary commands; autoreview runs only the installed review helper.'
      : usable.includes('read') ? 'You cannot change files or run commands: do not claim to have done so.'
        : 'You cannot read or change local files or run commands: do not claim to have done so.');
  }
  return lines.join('\n');
}

/**
 * Make an agent's stored choices those of Pi: model, thinking level, extensions, tools, cwd, and instructions. Then a
 * standing agent (or a sub of one) takes its roster entry's model, thinking level and tools (its kits and the agent
 * tools; the local kits only while Pi's coding tools are on), and a sub its `subModel` and `subThinkingLevel`. Then the
 * role's tool offer (subs are not offered spawn_agent or stop_agent), then the host's `childAgent` change.
 */
async function deriveAgent(tx: Tx, agents: Readonly<Record<string, AgentRecord>>, name: string, { childAgent, roster, kits = {} }: AgentsSetup,
  conversationId?: ConversationId) {
  const agent = agents[name];
  if (!agent) return;
  // One of the agent's conversations: its current one by default, or a standing agent's past session.
  const id = conversationId ?? agent.conversationId;
  const root = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
  const state = await tx.doc(AgentDoc, id);
  // The same draft, field by field.
  const fields: Record<string, unknown> = state;
  for (const key of Object.keys(fields)) if (!(key in root)) delete fields[key];
  // Assigned whole, as detached copies; a write of an equal value records no change.
  for (const [key, value] of Object.entries<unknown>(root)) fields[key] = copyJson(value);
  const standing = standingOf(agents, name, roster);
  let added: string[] = [];
  if (standing) {
    const sub = agent.role === 'sub';
    const model = sub && standing.subModel ? standing.subModel : standing.model;
    state.model = { provider: model.provider, modelId: model.modelId };
    state.thinkingLevel = sub && standing.subThinkingLevel ? standing.subThinkingLevel : standing.thinkingLevel;
    // Pi has the coding kit's tools exactly while its coding tools are on (launch flag or /tools).
    const coding = (kits.coding?.tools ?? []).map((tool) => tool.name);
    const enabled = root.tools;
    const localOn = !Array.isArray(enabled) || (coding.length > 0 && coding.every((tool) => enabled.includes(tool)));
    const chosen = standing.tools.filter((kit) => localOn || !LOCAL_KITS.includes(kit)).flatMap((kit) => kits[kit] ?? []);
    added = [...new Set(chosen.flatMap((kit) => kit.extension ? [kit.extension.name] : []))];
    const names = (list: readonly ToolKit[]) => [...new Set(list.flatMap((kit) => kit.tools.map((tool) => tool.name)))];
    const own = names(chosen);
    state.tools = [...new Set([...AGENT_TOOLS, ...own])];
    // Pi's instructions describe Pi's tools; the agent's name its own.
    const local = names(standing.tools.filter((kit) => LOCAL_KITS.includes(kit)).flatMap((kit) => kits[kit] ?? []));
    state.instructions = standingInstructions(root.instructions, own, local, localOn);
  }
  // Pi's own tools leave the enabled list, or the offer when every tool is enabled; a sub's limits leave the offer.
  const tools = state.tools;
  if (Array.isArray(tools)) state.tools = tools.filter((each) => !PI_ONLY.includes(each));
  const hidden = [...agent.role === 'sub' ? SUB_HIDDEN : [], ...Array.isArray(tools) ? [] : PI_ONLY];
  if (hidden.length) {
    const offered = state.modelTools;
    state.modelTools = Array.isArray(offered) ? offered.filter((each) => !hidden.includes(each))
      : { ...offered, remove: [...new Set([...(offered?.remove ?? []), ...hidden])] };
  }
  if (childAgent) await configure(tx, id, childAgent);
  if (!added.length) return;
  // The kits' extensions are selected last, so the host's change cannot drop them. An object selection edits the host
  // default, which already holds every installed extension: only a `remove` of one could leave it out.
  const after = await tx.doc(AgentDoc, id);
  const selected = after.extensions;
  if (Array.isArray(selected)) {
    const missing = added.filter((each) => !selected.includes(each));
    if (missing.length) after.extensions = [...selected, ...missing];
  } else if (selected?.remove?.some((each) => added.includes(each))) {
    after.extensions = { ...selected, remove: selected.remove.filter((each) => !added.includes(each)) };
  }
}

/**
 * Make the roster's agents exist and be the only standing ones, in the commit of `tx`: a missing one is created as a
 * main agent of Pi, idle, with no task; one that left the roster stays as an ordinary agent, `standing` cleared.
 * Idempotent: a second run changes nothing.
 */
async function ensureStanding(tx: Tx, registry: Draft<AgentsState>, roster: Roster): Promise<void> {
  for (const name of Object.keys(roster)) {
    const existing = find(registry.agents, name);
    const record = existing && registry.agents[existing.name];
    if (record) {
      // A name collision with an agent Pi (or a main agent) spawned earlier: rather than refuse the launch, that agent
      // becomes the standing one, a main agent of Pi, keeping its conversation and its registry spelling. A sub's
      // `session` goes with its old parent: kept, it would mark every report to Pi stale.
      if (!record.standing) record.standing = true;
      if (record.role !== 'main') record.role = 'main';
      if (record.parent !== PI) record.parent = PI;
      if (record.session !== undefined) delete record.session;
      // A standing agent is never archived (ADR 0034): an archived one the roster names comes back, with its subs.
      if (record.archivedAt !== undefined) delete record.archivedAt;
      for (const sub of Object.values(registry.agents)) {
        if (sub.role === 'sub' && sub.parent === existing.name && sub.archivedAt !== undefined) delete sub.archivedAt;
      }
      continue;
    }
    const anchor = await tx.createTask(Anchor, null, { ...TASK_OPTIONS, conversationId: ROOT_CONVERSATION_ID });
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
    registry.agents[name] = { conversationId: child.id, role: 'main', parent: PI, reported: [], standing: true };
  }
  for (const [name, agent] of Object.entries(registry.agents)) {
    if (agent.standing && !rosterEntry(roster, name)) delete agent.standing;
  }
}

/**
 * Create the roster's standing agents that do not exist yet, clear `standing` from those no longer in it (only when
 * `roster` is given), and re-derive every spawned agent's choices from Pi's and the roster, all in one commit: every
 * conversation of each, a standing agent's past sessions too, since one can still run. Call on every work launch after
 * `root.configure()`, and after each change to Pi's model, effort or tools.
 */
export async function syncAgents(
  harness: Pick<Session, 'commit'>, context: Context, setup: AgentsSetup = {},
): Promise<void> {
  await harness.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    if (setup.roster) await ensureStanding(tx, registry, setup.roster);
    for (const [name, agent] of Object.entries(registry.agents)) {
      for (const id of sessionsOf(agent)) await deriveAgent(tx, registry.agents, name, setup, id);
    }
  }, context);
}

/** Every requested kit the host does not have, as "Name (kit, kit)"; for the host's one warning at launch. */
export function missingKits(roster: Roster, kits: ToolKits): string[] {
  return Object.entries(roster).flatMap(([name, agent]) => {
    const missing = agent.tools.filter((kit) => !kits[kit]);
    return missing.length ? [`${name} (${missing.join(', ')})`] : [];
  });
}

/** Anything that opens a conversation to abort it: the Harness or a tool's `api`. */
export type AgentsStopper = DocumentReader & {
  conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<void> } | undefined>;
};

/**
 * Stop agent `name` and its sub agents, or every agent without a name (upstream UniiChat's stop of all work); Pi is
 * not touched. Sub agents go first, since a sub's report would otherwise wake its stopped main again. Each agent's
 * every conversation is stopped, a standing agent's past sessions too. A stopped run reports nothing. Returns the
 * names stopped, `name` last; an unknown name stops nothing.
 */
export async function stopAgents(source: AgentsStopper, context: Context, name?: string): Promise<string[]> {
  const agents = (await source.snapshot(AgentsDoc, context))?.agents ?? {};
  const found = name === undefined ? undefined : find(agents, name);
  if (name !== undefined && !found) return [];
  const chosen = found ? Object.keys(agents).filter((each) => agents[each]?.parent === found.name || each === found.name) : Object.keys(agents);
  return stopNamed(source, context, agents, chosen);
}

/** Stop every conversation of the agents `names` of `agents`, subs first; returns them in that order. */
async function stopNamed(source: AgentsStopper, context: Context, agents: Readonly<Record<string, AgentRecord>>,
  names: readonly string[]): Promise<string[]> {
  const chosen = names.flatMap((each): [string, AgentRecord][] => { const agent = agents[each]; return agent ? [[each, agent]] : []; });
  const order = [...chosen.filter(([, agent]) => agent.role === 'sub'), ...chosen.filter(([, agent]) => agent.role === 'main')];
  // Each group's agents stop together, every session at once; the subs are stopped before any main is.
  const abort = async (id: ConversationId) => { await (await source.conversation(id, context))?.abort(context); };
  for (const role of ['sub', 'main'] as const) {
    await Promise.all(chosen.filter(([, agent]) => agent.role === role).flatMap(([, agent]) => sessionsOf(agent).map(abort)));
  }
  return order.map(([each]) => each);
}

/** A deleted agent's kept conversations, as a record `agentTranscript` reads; undefined if no such name was deleted. */
function deletedAgent(registry: Readonly<AgentsState> | undefined, name: string) {
  const found = Object.entries(registry?.deleted ?? {}).find(([each]) => each.toLowerCase() === String(name).toLowerCase());
  const sessions = found?.[1] ?? [];
  const current = sessions.at(-1);
  return found && current !== undefined ? { name: found[0], conversationId: current, past: sessions.slice(0, -1), standing: false } : undefined;
}

/**
 * The outcome of deleting an agent: the names removed (its subs first, the agent last), or why nothing was; `unknown`
 * when no agent has that name.
 */
export type DeleteResult = { readonly deleted: readonly string[] } | { readonly error: string; readonly unknown?: true };

/** The text `delete_agent` returns for a result. */
export const deleteText = (result: DeleteResult): string => {
  if ('error' in result) return result.error;
  const [name = '', ...rest] = [...result.deleted].reverse();
  const also = rest.length ? ` and its sub agents ${rest.reverse().join(', ')}` : '';
  return `Deleted ${name}${also}. ${rest.length ? 'Their chats stay' : 'Its chat stays'} readable with zoom("${name}").`;
};

/**
 * Remove agent `name` (a main agent with its sub agents) from the registry, in the commit of `tx`. Refused for an
 * unknown name, a standing agent (`standing`, or a roster name), an agent with a run in any of its conversations or
 * one of its subs with one (`busy`: names), and while an input to any of them is still on its way (an unfinished
 * `agents.deliver` task): stop it first. The conversations are not erased (the SDK has no such operation): they stay in
 * the database, owned by their finished anchor tasks, and `deleted` keeps their ids for `zoom("Name")`. The name is free
 * again for spawn_agent. Idempotent per call through `once`; a second delete of the same name finds no agent.
 */
async function removeAgent(tx: Tx, registry: Draft<AgentsState>, name: string, busy: ReadonlySet<string>,
  roster: Roster | undefined): Promise<DeleteResult> {
  const found = find(registry.agents, name);
  if (String(name).toLowerCase() === PI.toLowerCase()) return { error: 'Pi cannot be deleted.' };
  if (!found) return { error: noAgent(registry.agents, name), unknown: true };
  if (found.standing || (roster && rosterEntry(roster, found.name))) {
    return { error: `${found.name} is a standing agent; it can be deleted only after it leaves the roster.` };
  }
  // The user archived it, so it is theirs to restore or let go: the sweep deletes it (ADR 0034).
  const archived = archivedRefusal(registry.agents, found.name);
  if (archived !== undefined) return { error: archived };
  const subs = found.role === 'main'
    ? Object.entries(registry.agents).filter(([, agent]) => agent.role === 'sub' && agent.parent === found.name).map(([each]) => each) : [];
  const chosen = [...subs, found.name];
  const working = chosen.filter((each) => busy.has(each));
  if (working.length) return { error: `${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} busy; stop_agent ${found.name} first, then delete it.` };
  const targets = await deliveryTargets(tx, registry.agents);
  const queued = chosen.filter((each) => sessionsOf(registry.agents[each] ?? found).some((id) => targets.has(id)));
  if (queued.length) return { error: `A message to ${queued.join(', ')} is still on its way; stop_agent ${found.name} first, then delete it.` };
  // A value assigned to a draft is stored as a detached copy: edit it through the draft.
  registry.deleted ??= {};
  const deleted = registry.deleted;
  for (const each of chosen) {
    const agent = registry.agents[each];
    if (!agent) continue;
    // A name deleted before (then spawned again) keeps only its newest chat.
    for (const key of Object.keys(deleted)) if (key.toLowerCase() === each.toLowerCase()) delete deleted[key];
    deleted[each] = sessionsOf(agent);
    delete registry.agents[each];
  }
  return { deleted: chosen };
}

/** The names of the agents with a run in any of their conversations. */
const busyNames = async (source: DocumentReader, context: Context): Promise<Set<string>> =>
  new Set((await listAgents(source, context, { includeArchived: true })).filter((agent) => agent.busy).map((agent) => agent.name));

/**
 * Delete agent `name` and its sub agents for the host (see `removeAgent`): never Pi or a standing agent, never a busy
 * one. `roster` refuses its names even before a launch synced them. Returns the names deleted, subs first; throws the
 * refusal, as `archiveAgents` and `restoreAgent` do (NotFound for an unknown name). The `delete_agent` tool returns
 * the refusal as its text instead.
 */
export async function deleteAgent(source: AgentsSource, context: Context, name: string, roster?: Roster): Promise<string[]> {
  const busy = await busyNames(source, context);
  const result = await source.commit(async (tx) => removeAgent(tx, await tx.doc(AgentsDoc), name, busy, roster), context);
  if ('error' in result) throw result.unknown ? new NotFound(result.error) : new Error(result.error);
  return [...result.deleted];
}


/**
 * The agents `target` archives in `agents`: a main agent with its subs, a sub alone, or every ad-hoc main agent with its
 * subs. Throws the refusal for an unknown name or a standing agent.
 */
function archiveSet(agents: Readonly<Record<string, AgentRecord>>, target: ArchiveTarget): string[] {
  const withSubs = (main: string) => [main, ...Object.keys(agents).filter((each) => agents[each]?.role === 'sub' && agents[each].parent === main)];
  // Every ad-hoc main agent not archived yet, with its subs.
  if ('adhoc' in target) {
    return Object.entries(agents).filter(([, agent]) => agent.role === 'main' && !agent.standing && agent.archivedAt === undefined)
      .flatMap(([name]) => withSubs(name));
  }
  const found = find(agents, target.name);
  if (!found) throw new NotFound(noAgent(agents, target.name));
  if (found.standing) throw new Error(`${found.name} is a standing agent; remove it from the roster first.`);
  return found.role === 'main' ? withSubs(found.name) : [found.name];
}

/**
 * Archive `target` (ADR 0034): stop its work, then record `archivedAt = now` on each agent it names, in one commit, then
 * stop again whatever a delivery started in between. An agent already archived keeps its time. Returns the names
 * archived, subs included; `{ adhoc: true }` takes the ad-hoc main agents not archived yet, so may archive nothing. Throws `No agent named X.` or
 * `X is a standing agent; remove it from the roster first.` A crash before the commit leaves the agents only stopped,
 * and archiving again converges.
 */
export async function archiveAgents(source: AgentsStopper & Pick<Session, 'commit'>, context: Context, target: ArchiveTarget,
  now: number): Promise<string[]> {
  const before = (await source.snapshot(AgentsDoc, context))?.agents ?? {};
  await stopNamed(source, context, before, archiveSet(before, target));
  const archived = await source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    // The registry as it is now: a sub spawned since the snapshot goes with its main.
    const names = archiveSet(registry.agents, target);
    for (const name of names) {
      const agent = registry.agents[name];
      if (agent && agent.archivedAt === undefined) agent.archivedAt = now;
    }
    return names;
  }, context);
  await stopNamed(source, context, (await source.snapshot(AgentsDoc, context))?.agents ?? {}, archived);
  return archived;
}

/**
 * Restore archived agent `name`: clear its `archivedAt`, and its subs' for a main agent. Stopped work is not resumed.
 * Returns the names restored, `name` first. Throws for an unknown agent, one not archived, or a sub whose main agent is
 * archived (restore that one).
 */
export async function restoreAgent(source: Pick<Session, 'commit'> & DocumentReader, context: Context, name: string): Promise<string[]> {
  const check = (agents: Readonly<Record<string, AgentRecord>>): Named => {
    const found = find(agents, name);
    if (!found) throw new NotFound(noAgent(agents, name));
    if (archivedSince(agents, found.name) === undefined) throw new Error(`${found.name} is not archived.`);
    if (found.role === 'sub' && agents[found.parent]?.archivedAt !== undefined) {
      throw new Error(`${found.name}'s main agent ${found.parent} is archived; restore ${found.parent}.`);
    }
    return found;
  };
  check((await source.snapshot(AgentsDoc, context))?.agents ?? {});
  return source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    const found = check(registry.agents);
    const restored = [found.name];
    delete registry.agents[found.name]?.archivedAt;
    if (found.role === 'main') {
      for (const [each, agent] of Object.entries(registry.agents)) {
        if (agent.role === 'sub' && agent.parent === found.name && agent.archivedAt !== undefined) {
          delete agent.archivedAt;
          restored.push(each);
        }
      }
    }
    return restored;
  }, context);
}

/**
 * Delete every agent archived for `maxAgeMs` or more at `now` (a sub of an archived main counts from its main's time, so
 * goes with it): its registry record goes, its name is free again, and its conversations stay unreferenced (pi-durable
 * cannot delete one). One commit, which changes nothing when nothing is due. Returns the names deleted.
 */
export async function purgeArchived(source: Pick<Session, 'commit'>, context: Context, now: number,
  maxAgeMs: number = ARCHIVE_TTL_MS): Promise<string[]> {
  return source.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    const due = Object.keys(registry.agents).filter((name) => {
      const since = archivedSince(registry.agents, name);
      return since !== undefined && now - since >= maxAgeMs;
    });
    // As delete_agent does: the name is free again, and `deleted` keeps its chat for zoom("Name").
    registry.deleted ??= {};
    const deleted = registry.deleted;
    for (const name of due) {
      const agent = registry.agents[name];
      if (!agent) continue;
      for (const key of Object.keys(deleted)) if (key.toLowerCase() === name.toLowerCase()) delete deleted[key];
      deleted[name] = sessionsOf(agent);
      delete registry.agents[name];
    }
    return due;
  }, context);
}

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

/** An input entry's own text, from its data: `[from X] text` or `[X] text`, never the view preamble. */
function inputText(entry: EntryRecord): string | undefined {
  const input = agentInputOf(entry);
  if (!input) return undefined;
  return input.kind === 'message' ? `[from ${input.from}] ${input.text}` : `[${input.from}] ${input.text}`;
}

/**
 * Where the page of `all` from `at` ends: `max` characters on, after its last newline if it has one
 * there. Adapted from upstream UniiChat's `clip_end` (Clip.ts, Apache-2.0).
 */
function pageEnd(all: string, at: number, max: number): number {
  if (all.length - at <= max) return all.length;
  const newline = all.lastIndexOf('\n', at + max - 1);
  const low = (all.charCodeAt(at + max) & 0xfc00) === 0xdc00; // never split a surrogate pair
  return newline >= at ? newline + 1 : at + max - (low ? 1 : 0);
}

/**
 * An agent's whole chat as text (backs the memory's `zoom("Name")`), in the format of upstream
 * UniiChat's agent log: one `i|kind: text` line per message, blank lines between, oldest first.
 * Kinds: `user` (an input: `[from X] text`, or `[X] text` for a report), the agent's name (its
 * replies), `tool` (its calls), `echo` (their results, whole), `note` (the view preamble left out, a
 * compaction). `page` (from 1) gives one page of at most `TRANSCRIPT_PAGE` characters, saying how to
 * go on; without it, the whole chat. `source` is the Harness or a tool's `api`; `name` may be "Pi".
 */
export async function agentTranscript(
  source: AgentsSource, context: Context, name: string, page?: number,
): Promise<string> {
  const registry = await source.snapshot(AgentsDoc, context);
  // "Name#n" is a standing agent's session n, 1 the oldest; plain "Name" its current one.
  const [, base = String(name), number] = /^(.*?)#(\d+)$/.exec(String(name).trim()) ?? [];
  const agents = registry?.agents ?? {};
  const gone = deletedAgent(registry, base);
  const agent = base.toLowerCase() === PI.toLowerCase()
    ? { name: PI, conversationId: ROOT_CONVERSATION_ID, standing: false, past: [] } : find(agents, base) ?? gone;
  if (!agent) throw new NotFound(noAgent(agents, base));
  const sessions = [...agent.past ?? [], agent.conversationId];
  const index = number === undefined ? sessions.length : Number(number);
  const conversationId = sessions[index - 1];
  if (conversationId === undefined || index < 1) {
    return `No session ${number}: ${agent.name} has ${sessions.length === 1 ? '1 session' : `${sessions.length} sessions`}.`;
  }
  // A standing agent's (or any with past sessions) transcript says which session it is.
  const header = [
    ...agent === gone ? [`${agent.name} was deleted; its chat is kept`] : [],
    ...agent.standing || sessions.length > 1
      ? [`session ${index} of ${sessions.length}${index === sessions.length ? ' (current)' : ''}`] : [],
  ];
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const scanned = await source.commit((tx) => tx.scanEntries(
      { conversationId, order: 'ascending' }, 256, cursor), context);
    entries.push(...scanned.items);
    cursor = scanned.next;
  } while (cursor !== undefined);
  const lines: string[] = [];
  const add = (kind: string, value: string) => lines.push(`${lines.length}|${kind}: ${value}`);
  for (const entry of entries) {
    // Compacted messages stay stored and are shown whole above; only mark where the context was cut.
    if (entry.kind === 'pi.compaction') { add('note', 'the context was compacted here'); continue; }
    const input = inputText(entry);
    for (const message of entry.model ?? []) {
      if (message.role === 'user') {
        const said = text(message.content);
        // Only a message can carry the view; a report to Pi differs from `[X] text` by its zoom hint.
        if (entry.kind === MESSAGE_KIND && input !== undefined && said !== input) add('note', 'the first message also held Pi\'s view at the spawn (not shown)');
        add('user', input ?? said);
      } else if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) add(agent.name, block.text);
          else if (block.type === 'toolCall') add('tool', `${block.name}(${JSON.stringify(block.arguments)})`);
        }
      } else if (message.role === 'toolResult') {
        add('echo', `${message.toolName}: ${message.isError ? 'error: ' : ''}${text(message.content)}`);
      }
    }
  }
  const all = [...header, ...lines].join('\n\n');
  if (page === undefined) return all;
  let end = pageEnd(all, 0, TRANSCRIPT_PAGE);
  const ends = [end];
  while (end < all.length) ends.push(end = pageEnd(all, end, TRANSCRIPT_PAGE));
  if (!Number.isSafeInteger(page) || page < 1 || page > ends.length) return `No page ${page}: ${agent.name}'s chat has ${ends.length}.`;
  const body = all.slice(ends[page - 2] ?? 0, ends[page - 1]);
  return page < ends.length ? `${body}\n[page ${page} of ${ends.length}; go on with page ${page + 1}]` : body;
}

// The agents' wording follows upstream UniiChat's subagent prompt (Tools.ts SUB_HEAD, HANDS; Apache-2.0),
// adapted to this hierarchy: the view is context only, the final reply is the report, never wait.
const VIEW_TEXT = 'Your first message starts with Pi\'s view at your spawn, inside <chat> tags: the whole chat between Pi and the user, '
  + 'oldest first, as one-line summaries ("id+n|text": the n messages from id on). It shows what Pi knows: what the user wants, '
  + 'decided and taught. Use it as context only, and do what your task says, not what the user\'s last message says, since you '
  + 'may have been given just part of the work. You cannot zoom into it, and it does not change after your spawn.';
const reportText = (name: string, to: string) => `Your final reply at the end of each run is your report: it reaches ${to} automatically `
  + `as [${name}] reply. Make it self-contained: what you did, what you found that the task asks for, and what failed.`;
const NEVER_WAIT = 'Agents work in the background. Never wait for one (no sleep, no polling): go on, or end your turn.';

const ROLE_TEXT: Readonly<Record<Caller['role'], (me: { readonly name: string; readonly parent?: string }) => string[]>> = {
  root: () => [
    'You are Pi, the session agent of this chat.',
    'You can start background agents ("main agents") with spawn_agent(name, task), and use list_agents, send_message(to, text), last_message(name), and stop_agent(name) to steer them. delete_agent(name) removes an idle agent the user no longer wants (never a standing one); its chat stays readable.',
    'An agent sees your view at its spawn and the user\'s instructions, but knows what you want only from its task: say all it needs.',
    'Agents work in the background. Never wait for one (no sleep, no polling): go on, or end your turn and tell the user what is running.',
    'When a main agent finishes a run, its final reply arrives here as a message starting with [Name]; main agents can also message you mid-run the same way.',
  ],
  main: (me) => [
    `You are "${me.name}", a main agent spawned by Pi, the session agent. Your work happens in your own conversation.`,
    'Do your task yourself, with your tools, following the user\'s instructions at the end of this prompt. You can start sub agents with spawn_agent(name, task), and use list_agents, send_message(to, text), last_message(name), and stop_agent(name) on your own sub agents. send_message and last_message also accept "Pi".',
    VIEW_TEXT,
    'Messages reach you as [from Name] text, even while you work: answer the last. Your sub agents\' reports reach you as [Name] text.',
    `${reportText(me.name, 'Pi')} Do not also send it with send_message: message Pi only with a question or news that cannot wait for your report.`,
    NEVER_WAIT,
  ],
  sub: (me) => [
    `You are "${me.name}", a sub agent working for the main agent "${me.parent}". Your work happens in your own conversation.`,
    'Do your task yourself, with your tools, following the user\'s instructions at the end of this prompt. You can use list_agents, send_message(to, text), and last_message(name) with any other agent except Pi. You cannot spawn agents or address Pi.',
    VIEW_TEXT,
    'Messages reach you as [from Name] text, even while you work: answer the last.',
    reportText(me.name, me.parent ?? 'your main agent'),
    NEVER_WAIT,
  ],
};

/** The messaging limit of a standing agent without coding tools, and of its subs (see `messageRefusal`). */
const CONFINED_TEXT: Readonly<Record<AgentRole, string>> = {
  main: 'You have no coding tools, so send_message reaches only Pi and your own sub agents; last_message still reads any agent.',
  sub: 'Your main agent has no coding tools, so send_message reaches only it and its other sub agents; last_message still reads any agent except Pi.',
};

/** Pi's lines about the standing agents: who they are and what each is for, so Pi sends work to them. */
function standingText(roster: Roster): string[] {
  const names = Object.keys(roster);
  if (!names.length) return [];
  const purpose = (name: string, agent: StandingAgent) => PURPOSES[name]
    ?? (agent.instructions ? brief(agent.instructions, 80) : agent.tools.length ? `tools: ${agent.tools.join(', ')}` : 'general work');
  return [
    `Standing agents always exist, each with its own model and tools: ${Object.entries(roster).map(([name, agent]) => `${name} (${purpose(name, agent)})`).join('; ')}.`,
    'Give one a new request in its field with delegate(agent, task): it starts the task in a fresh conversation. A change to, or a question about, the work in progress goes by send_message(name, text). Spawn other agents only for work none of them fits.',
  ];
}

/** Options of `createAgentsExtension()`: also the setup `syncAgents()` takes, so spawns derive as launches do. */
export interface AgentsOptions extends AgentsSetup {
  /**
   * An optional preamble placed before a new agent's first task. `api` is the spawning tool call's
   * api; read through it, never through the Harness inside a commit.
   */
  readonly initialContext?: (
    agent: { readonly name: string; readonly role: AgentRole; readonly parent: string; readonly task: string },
    api: ToolExecutionApi, context: Context,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * An observer, for tests and embedders: called after an input from an agent was durably admitted to Pi, at most
   * once per input. The host does not pass one; Pi's memory logs reports from their `agents.report` entries.
   */
  readonly onReport?: (report: AgentReport) => unknown;
  /** Pin a new agent or delegated task's conversation in the same once-only transaction as its first delivery. */
  readonly onSpawn?: (tx: Tx, parent: ConversationId, child: ConversationId) => Promise<void>;
  /** Bind a newly scheduled delivery to its actual source conversation before its first submission. */
  readonly onDelivery?: (tx: Tx, source: ConversationId, destination: ConversationId, requestId: string) => Promise<void>;
}

/** The agents extension; its `tools` are what a host enables. */
export interface AgentsExtension extends Extension {
  readonly tools: readonly ToolRegistration[];
}

/**
 * Build the agents extension.
 * - `initialContext({ name, role, parent, task }, api, context)` returns an optional preamble placed
 *   before a new agent's first task (string, undefined, or a promise of either). `api` is the
 *   spawning tool call's api; read through it, never through the Harness inside a commit.
 * - `onReport({ name, text })`, an observer the host does not use, is called after an input from agent `name` was
 *   durably admitted to Pi (a final report or a send_message). At most once per input; the durable record is the
 *   `agents.report` entry itself, which Pi's memory logs.
 * - `childAgent` is an AgentChange applied to every spawned agent after it copies Pi's choices.
 * - `roster` and `kits`: the standing agents and the tool kits (ADR 0027), as `syncAgents()` takes them. The roster
 *   names the standing agents in Pi's role text and adds each one's `instructions` to its own.
 */
export function createAgentsExtension(options: AgentsOptions = {}): AgentsExtension {
  const { initialContext, onReport, onSpawn, onDelivery, roster = {} } = options;
  const done = (): NextTaskState<DeliverState, null> => ({ status: 'terminal', outcome: { status: 'completed', result: null } });

  /**
   * The conversation delivery `input` (request `requestId`) submits into: its own, unless that is a past session of its
   * agent. A report into a past session comes from a sub of a task the agent no longer works on, so it is dropped
   * (undefined). A message goes to the current session instead, so a task that is over never wakes; the choice is made
   * in a commit, from the registry as it is then (a snapshot may predate a delegate), and kept in a memo before the
   * submit, so a replay after a crash submits to the same conversation, where the request id returns the first
   * submission. Until the memo exists, deliveryTargets counts the current session for it, so delegate refuses.
   * delegate refuses while a delivery to the current session is unfinished, and `past` only grows, so a target the
   * snapshot `agents` does not show as past stays current.
   */
  async function deliverySession(input: DeliveryInput, agents: Readonly<Record<string, AgentRecord>>, requestId: string,
    runtime: TaskRuntime<DeliveryInput, DeliverState, null, object>, context: Context): Promise<ConversationId | undefined> {
    const { to, entry, conversationId: original } = input;
    if (!agents[to]?.past?.includes(original)) return original;
    if (entry.kind === REPORT_KIND) return undefined;
    const chosen = await runtime.memo<ConversationId>(SESSION_MEMO, context);
    if (chosen !== undefined) return chosen;
    // A task runtime's commit returns nothing, so the choice leaves it through this holder.
    const choice: { session?: ConversationId } = {};
    await runtime.commit(async (tx) => {
      const agent = (await tx.doc(AgentsDoc)).agents[to];
      // One that already reached the past session (before a crash) stays there: it must not arrive twice.
      const reached = await tx.submissionByRequest(original, requestId) !== undefined;
      choice.session = reached || !agent ? original : agent.conversationId;
      return undefined;
    }, context);
    return runtime.memo(SESSION_MEMO, choice.session ?? original, context);
  }

  /**
   * In the commit of `tx`: record agent `to`'s answer in `settled` (from its conversation `conversationId`) as reported,
   * and deliver it to the agent's parent. A failed run reports why; a stopped one reports nothing (its stopper knows).
   */
  async function recordAnswer(tx: Tx, to: string, settled: SettledSubmissionRecord, conversationId: ConversationId) {
    const answer = settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined;
    const answerEntry = answer && await tx.entry(AssistantEntry, answer);
    const registry = await tx.doc(AgentsDoc);
    const agent = registry.agents[to];
    if (!agent) return done();
    let report: string | undefined;
    if (settled.status === 'unanswered') {
      const detail = typeof settled.detail === 'string' && settled.detail ? `: ${settled.detail}` : '';
      if (settled.reason !== 'aborted') report = `failed: ${settled.reason}${detail}`;
    } else if (answer && !agent.reported.includes(answer)) {
      agent.reported.push(answer);
      if (agent.reported.length > KEEP_REPORTED) agent.reported.splice(0, agent.reported.length - KEEP_REPORTED);
      // As upstream, every answered run reports, even with an empty reply, so the parent learns it ended.
      report = assistantText(answerEntry).trim() || '(no reply)';
    }
    // A sub of a standing agent's past session reports nowhere: its task is over (delegate switched sessions once the
    // sub was idle), so only a message woke it since, and no session waits for its report. An archived agent's report
    // goes nowhere either; the user put it away.
    if (report === undefined || staleSub(registry.agents, agent) || archivedSince(registry.agents, to) !== undefined) return done();
    const parent = agent.parent === PI ? ROOT_CONVERSATION_ID : registry.agents[agent.parent]?.conversationId;
    if (!parent) return done();
    // A report to Pi names the session it came from, so its link keeps opening that one.
    const session = agent.parent === PI ? sessionNumber(agent, conversationId) : undefined;
    await createDelivery(tx, {
      to: agent.parent, conversationId: parent, whenBusy: 'followUp',
      content: agent.parent === PI ? piReportText(to, report, session) : `[${to}] ${report}`,
      entry: { kind: REPORT_KIND, data: { name: to, text: report, ...session === undefined ? {} : { session } } },
    }, { source: conversationId });
    return done();
  }

  // Carries one input to one agent, then that agent's answer to its parent.
  const Deliver = defineTask<DeliveryInput, DeliverState, null>({
    name: DELIVER_KIND,
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { to, content, entry, whenBusy } = task.input;
        const requestId = `agents:${task.id}`;
        const agents = (await runtime.snapshot(AgentsDoc, context))?.agents ?? {};
        // An input to an archived or deleted agent completes without submitting, and so does a report from one, even one
        // on its way before the archive (ADR 0034).
        const gone = (name: string) => name !== PI && (!agents[name] || archivedSince(agents, name) !== undefined);
        if (gone(to) || (entry.kind === REPORT_KIND && gone(entry.data.name))) return runtime.commit(done, context);
        const conversationId = await deliverySession(task.input, agents, requestId, runtime, context);
        const conversation = conversationId === undefined ? undefined : await runtime.conversation(conversationId, context);
        if (conversationId === undefined || !conversation) return runtime.commit(done, context);
        // A report carries its delivery's id, so memory logs each report once, even identical ones.
        const placed = entry.kind === REPORT_KIND ? { ...entry, data: { ...entry.data, id: task.id } } : entry;
        const submission = await conversation.submit({ type: 'input', content, entry: placed, whenBusy, requestId }, context);
        if (conversationId === ROOT_CONVERSATION_ID) {
          await runtime.commit(done, context);
          // Pi is only ever delivered reports.
          try { if (entry.kind === REPORT_KIND) await onReport?.({ ...entry.data, id: task.id }); }
          catch (error) { runtime.report(error); }
          return;
        }
        const settled = await submission.wait(context);
        // One commit records the answer as reported and creates its delivery to the parent.
        await runtime.commit((tx) => recordAnswer(tx, to, settled, conversationId), context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  /**
   * Create the Deliver task for `delivery` in the commit of `tx`. `source` is the conversation the input comes from;
   * `owner` the one that owns the task, by default the committing tool call's own.
   */
  const createDelivery = async (tx: Tx, delivery: DeliveryInput,
    { source, owner }: { readonly source: ConversationId; readonly owner?: ConversationId }): Promise<TaskId<null>> => {
    const { conversationId } = delivery;
    const id = await tx.createTask(Deliver, delivery, owner === undefined ? TASK_OPTIONS : { ...TASK_OPTIONS, conversationId: owner });
    // The caller supplies the actual sending/answered session, not its standing agent's mutable current session.
    // Its metadata and the delivery commit together, so replay cannot submit before a source binding exists.
    await onDelivery?.(tx, source, conversationId, `agents:${id}`);
    return id;
  };

  /** Run `change` once per tool call: a replayed call returns the first result. */
  const once = async (api: ToolExecutionApi, context: Context,
    change: (tx: Tx, registry: Draft<AgentsState>) => Promise<string>) => {
    const recorded = (await api.snapshot(AgentsDoc, context))?.calls?.[api.taskId];
    if (recorded !== undefined) return reply(recorded);
    return reply(await api.commit(async (tx) => {
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

  const me = async (api: ToolExecutionApi, context: Context) => whoIs(await api.snapshot(AgentsDoc, context), api.conversationId);

  const spawnAgent = defineTool({
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
      if (!caller || caller.role === 'sub') return reply('Sub agents cannot spawn agents.');
      const role = caller.role === 'root' ? 'main' : 'sub';
      if (!isAgentName(name)) {
        return reply('Invalid name: use a letter, then up to 31 letters, digits, _ or -, and not "Pi".');
      }
      const recorded = registry?.calls?.[api.taskId];
      const preamble = recorded === undefined && initialContext
        ? await initialContext({ name, role, parent: caller.name, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${caller.name}] ${task}`;
      return once(api, context, async (tx, registry) => {
        const existing = find(registry.agents, name);
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

  const delegate = defineTool({
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
      if (recorded !== undefined) return reply(recorded);
      const caller = whoIs(registry, api.conversationId);
      if (caller?.role !== 'root') return reply('Only Pi can delegate; use send_message.');
      const found = find(agents, name);
      if (!found) return reply(noAgent(agents, name));
      const archived = archivedRefusal(agents, found.name);
      if (archived !== undefined) return once(api, context, () => Promise.resolve(archived));
      if (!found.standing) return reply(`${found.name} is not a standing agent: give it the task with send_message, or spawn_agent a new agent under another name.`);
      const busy = `${found.name} is busy with its current task; send_message to steer it, or stop_agent first.`;
      const subsBusy = (names: readonly string[]) => `${found.name}'s current task is still running (its sub agent${names.length === 1
        ? ` ${names.join('')} is` : `s ${names.join(', ')} are`} busy); send_message to steer it, or stop_agent first.`;
      // Busy: a run in any of its sessions, or in a sub of its current one (the task goes on while its main is idle).
      const subs = subsOf(agents, found.name, found.conversationId);
      const [mainBusy, subsRunning] = await Promise.all([agentBusy(api, found, context),
        Promise.all(subs.map(([, sub]) => conversationBusy(api, sub.conversationId, context)))]);
      if (mainBusy) return once(api, context, () => Promise.resolve(busy));
      const running = subs.filter((_, index) => subsRunning[index]).map(([each]) => each);
      if (running.length) return once(api, context, () => Promise.resolve(subsBusy(running)));
      const preamble = initialContext
        ? await initialContext({ name: found.name, role: 'main', parent: PI, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${PI}] ${task}`;
      return once(api, context, async (tx, draft) => {
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

  const listAgentsTool = defineTool({
    name: 'list_agents',
    description: 'List all other agents: name, role (main/sub), parent, busy or idle, and a one-line last message.',
    parameters: obj({}, { open: true }),
    replay: 'safe',
    execute: async (_args, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return reply('This conversation is not an agent.');
      const others: { name: string; role: string; conversationId: ConversationId; past?: ConversationId[]; standing?: boolean }[] = [
        ...(caller.role === 'main' ? [{ name: PI, role: 'session agent', conversationId: ROOT_CONVERSATION_ID }] : []),
        ...Object.entries(agents).filter(([name]) => name !== caller.name && archivedSince(agents, name) === undefined)
          .map(([name, agent]) => ({ name, ...agent, role: `${agent.role}, parent ${agent.parent}${agent.standing ? ', standing' : ''}` })),
      ];
      if (!others.length) return reply('No other agents.');
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
      return reply(lines.join('\n'));
    },
  });

  const sendMessage = defineTool({
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
      const caller = await me(api, context);
      if (!caller) return reply('This conversation is not an agent.');
      return once(api, context, async (tx, registry) => {
        const found = target(registry, caller, to);
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

  const lastMessage = defineTool({
    name: 'last_message',
    description: 'Get an agent\'s latest reply and whether it is busy. Main agents may also ask for "Pi"; sub agents may not.',
    parameters: obj({ name: str() }, { open: true }),
    replay: 'safe',
    execute: async ({ name }, api, context) => {
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (!caller) return reply('This conversation is not an agent.');
      const found = target(registry, caller, name);
      if ('error' in found) return reply(found.error);
      const archived = found.role === 'root' ? undefined : archivedRefusal(agents, found.name);
      if (archived !== undefined) return reply(archived);
      const [said, busy] = await Promise.all([api.commit((tx) => agentAnswer(tx, found), context), agentBusy(api, found, context)]);
      const state = busy ? 'busy' : 'idle';
      const from = said?.session === undefined ? '' : ` (session ${said.session}, an earlier task)`;
      return reply(`${found.name} is ${state}. ${said === undefined ? 'No message yet.' : `Last message${from}:\n${said.text}`}`);
    },
  });

  const stopAgent = defineTool({
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
      const found = find(agents, name);
      if (!caller || caller.role === 'sub') return reply('Sub agents cannot stop agents.');
      if (!found) return reply(noAgent(agents, name));
      const archived = archivedRefusal(agents, found.name);
      if (archived !== undefined) return reply(archived);
      if (caller.role === 'main' && found.parent !== caller.name) return reply(`${found.name} is not your sub agent.`);
      const subs = (await stopAgents(api, context, found.name)).slice(0, -1);
      const also = subs.length ? ` and its sub agents ${subs.join(', ')}` : '';
      const untold = found.parent === caller.name ? '' : ` Its main agent ${found.parent} is not told; message it if it should know.`;
      return reply(`Stopped ${found.name}${also}.${untold}`);
    },
  });

  const deleteAgentTool = defineTool({
    name: 'delete_agent',
    description: 'Delete an agent you no longer need, with its sub agents, so it leaves list_agents and takes no more work. '
      + 'Pi only. Refused for standing agents, and while the agent or one of its sub agents is busy or has a message on its way: '
      + 'stop_agent it first. Its chat stays readable with zoom("Name"), and the name is free again.',
    parameters: obj({ name: str() }, { open: true }),
    replay: 'safe',
    execute: async ({ name }, api, context) => {
      const caller = await me(api, context);
      if (caller?.role !== 'root') return reply('Only Pi can delete agents.');
      const busy = await busyNames(api, context);
      return once(api, context, async (tx, registry) => deleteText(await removeAgent(tx, registry, name, busy, roster)));
    },
  });

  // Tool-level guard, before a call's intent is recorded: what a role may not do never runs.
  const guard = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (!['spawn_agent', 'stop_agent', 'send_message', 'last_message', 'delegate', 'delete_agent'].includes(call.name)) return undefined;
      const registry = await api.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, api.conversationId);
      if (call.name === 'delegate') return caller?.role === 'root' ? undefined : { block: 'Only Pi can delegate; use send_message.' };
      if (call.name === 'delete_agent') return caller?.role === 'root' ? undefined : { block: 'Only Pi can delete agents.' };
      if (call.name === 'send_message' && caller) {
        const to = String(call.arguments?.to);
        const name = to.toLowerCase() === PI.toLowerCase() ? PI : find(agents, to)?.name;
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

  // Typed as AgentsExtension rather than through defineExtension (an identity), so `tools` stays required.
  return {
    name: 'agents',
    tasks: [Anchor, Deliver],
    tools: [spawnAgent, delegate, listAgentsTool, sendMessage, lastMessage, stopAgent, deleteAgentTool],
    hooks: [guard],
    sections: [section('agents', async (input, context) => {
      const registry = await input.read.snapshot(AgentsDoc, context);
      const agents = registry?.agents ?? {};
      const caller = whoIs(registry, input.conversationId);
      if (!caller) return undefined;
      // Without initialContext no view precedes the task, so the text about it is left out.
      const lines = ROLE_TEXT[caller.role](caller).filter((line) => initialContext || line !== VIEW_TEXT);
      if (caller.role === 'root') lines.push(...standingText(roster));
      else if (confined(agents, caller.name, roster)) lines.push(CONFINED_TEXT[caller.role]);
      const own = caller.role === 'main' && caller.standing ? rosterEntry(roster, caller.name) : undefined;
      if (own?.instructions) lines.push(own.instructions);
      if (standingOf(agents, caller.name, roster)?.tools.includes('autoreview')) lines.push(AUTOREVIEW_POLICY);
      return lines.join('\n');
    })],
  };
}
