import { type Context, copyJson, type Draft } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type ImageContent, type Message, type TextContent, type ThinkingContent, type ToolCall, Type } from '@earendil-works/pi-ai';
import {
  AgentDoc, AssistantEntry, configure, defineDoc, defineTask, defineTool,
  hook, LiveDoc, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';
import type {
  AgentChange, ConversationId, Cursor, DocumentReader, EntryId, EntryRecord, Extension, NextTaskState,
  Session, TaskId, TaskOptions, ToolExecutionApi, ToolExecutionResult, ToolRegistration, Tx,
} from '@earendil-works/pi-durable';
import { isAgentName, type Kit, LOCAL_KITS, PURPOSES, type Roster, type StandingAgent } from './roster.ts';

export { AGENT_NAME, DEFAULT_ROSTER, isAgentName, isKit, KITS, LOCAL_KITS } from './roster.ts';
export type { Kit, Roster, StandingAgent } from './roster.ts';

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
export const REPORT_KIND = 'agents.report';
export const MESSAGE_KIND = 'agents.message';
const KEEP_CALLS = 256;
const KEEP_REPORTED = 32;
/**
 * An input reaching Pi from agent `name`, in upstream UniiChat's report format (Call.ts `report_text`, Apache-2.0):
 * the name, the text, and where Pi reads the agent's whole chat. Agents cannot zoom, so their inputs stay `[Name] text`.
 */
export const piReportText = (name: string, text: string): string => `[${name}]\n${text}\n\nFull chat: zoom("${name}")`;
/** The most characters of an agent's chat that one zoom("Name") page holds (upstream UniiChat Clip.ts CAP). */
export const TRANSCRIPT_PAGE = 30_000;

export type AgentRole = 'main' | 'sub';
/**
 * A registry entry. `parent` is "Pi" or a main agent's name; `reported` holds answers already reported. `standing` marks
 * a main agent of the roster (ADR 0027); absent on every other agent, and cleared when it leaves the roster.
 */
export type AgentRecord = { conversationId: ConversationId; role: AgentRole; parent: string; reported: EntryId[]; standing?: boolean };
/** `calls` maps a tool task ID to the result its first run returned. */
export type AgentsState = { agents: Record<string, AgentRecord>; calls: Record<string, string> };
/** An agent's input entry: a message from another agent, or a report to its parent (`id` once placed). */
export type MessageEntry = { kind: typeof MESSAGE_KIND; data: { from: string; text: string } };
export type ReportEntry = { kind: typeof REPORT_KIND; data: { name: string; text: string } };
/** An input that reached Pi; `id` is its delivery task's ID. */
export type AgentReport = { name: string; text: string; id: TaskId };
/** One row of `listAgents()`. */
export interface AgentInfo {
  readonly name: string;
  readonly role: AgentRole;
  readonly parent: string;
  readonly conversationId: ConversationId;
  readonly busy: boolean;
  /** A standing agent of the roster. */
  readonly standing: boolean;
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

/** Who the conversation is: Pi, a registered agent, or undefined for any other conversation. */
function whoIs(registry: Readonly<AgentsState> | undefined, conversationId: ConversationId): Caller | undefined {
  if (conversationId === ROOT_CONVERSATION_ID) return { name: PI, role: 'root', conversationId };
  for (const [name, agent] of Object.entries(registry?.agents ?? {})) {
    if (agent.conversationId === conversationId) return { name, ...agent };
  }
  return undefined;
}

/** Resolve a target; `Pi` only for those who may address it. */
function target(registry: Readonly<AgentsState> | undefined, me: Caller, name: string): Caller | { error: string } {
  if (String(name).toLowerCase() === PI.toLowerCase()) {
    if (me.role === 'sub') return { error: 'Sub agents cannot address Pi; message your main agent instead.' };
    return { name: PI, role: 'root', conversationId: ROOT_CONVERSATION_ID };
  }
  return find(registry?.agents ?? {}, name) ?? { error: `No agent named ${name}.` };
}

/** Latest committed assistant text of a conversation, read through a transaction. */
async function lastAnswer(tx: Tx, conversationId: ConversationId): Promise<string | undefined> {
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

const busyOf = async (source: DocumentReader, conversationId: ConversationId, context: Context) =>
  (await source.snapshot(LiveDoc, conversationId, context))?.run !== undefined;

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
const TASK_OPTIONS: TaskOptions = { ownership: { kind: 'conversation' }, background: true };

/** The roster entry whose choices agent `name` takes: its own for a standing main, its main's for a sub of one. */
function standingOf(agents: Readonly<Record<string, AgentRecord>>, name: string, roster: Roster | undefined): StandingAgent | undefined {
  const agent = agents[name];
  if (!agent || !roster) return undefined;
  const main = agent.role === 'main' ? name : agent.parent;
  return agents[main]?.standing ? rosterEntry(roster, main) : undefined;
}

/** The roster entry named `name`, ignoring case as every agent lookup does. */
const rosterEntry = (roster: Roster, name: string): StandingAgent | undefined =>
  Object.entries(roster).find(([each]) => each.toLowerCase() === name.toLowerCase())?.[1];

/**
 * Make an agent's stored choices those of Pi: model, thinking level, extensions, tools, cwd, and instructions. Then a
 * standing agent (or a sub of one) takes its roster entry's model, thinking level and tools (its kits and the agent
 * tools; the local kits only while Pi's coding tools are on), and a sub its `subModel` and `subThinkingLevel`. Then the
 * role's tool offer (subs are not offered spawn_agent or stop_agent), then the host's `childAgent` change.
 */
async function deriveAgent(tx: Tx, agents: Readonly<Record<string, AgentRecord>>, name: string, { childAgent, roster, kits = {} }: AgentsSetup) {
  const agent = agents[name];
  if (!agent) return;
  const root = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
  const state = await tx.doc(AgentDoc, agent.conversationId);
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
    state.tools = [...new Set([...AGENT_TOOLS, ...chosen.flatMap((kit) => kit.tools.map((tool) => tool.name))])];
  }
  if (agent.role === 'sub') {
    const offered = state.modelTools;
    state.modelTools = Array.isArray(offered) ? offered.filter((each) => !SUB_HIDDEN.includes(each))
      : { ...offered, remove: [...new Set([...(offered?.remove ?? []), ...SUB_HIDDEN])] };
  }
  if (childAgent) await configure(tx, agent.conversationId, childAgent);
  if (!added.length) return;
  // The kits' extensions are selected last, so the host's change cannot drop them. An object selection edits the host
  // default, which already holds every installed extension: only a `remove` of one could leave it out.
  const after = await tx.doc(AgentDoc, agent.conversationId);
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
      // becomes the standing one, a main agent of Pi, keeping its conversation and its registry spelling.
      if (!record.standing) record.standing = true;
      if (record.role !== 'main') record.role = 'main';
      if (record.parent !== PI) record.parent = PI;
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
 * `roster` is given), and re-derive every spawned agent's choices from Pi's and the roster, all in one commit. Call on
 * every work launch after `root.configure()`, and after each change to Pi's model, effort or tools.
 */
export async function syncAgents(
  harness: Pick<Session, 'commit'>, context: Context = BACKGROUND_CONTEXT, setup: AgentsSetup = {},
): Promise<void> {
  await harness.commit(async (tx) => {
    const registry = await tx.doc(AgentsDoc);
    if (setup.roster) await ensureStanding(tx, registry, setup.roster);
    for (const name of Object.keys(registry.agents)) await deriveAgent(tx, registry.agents, name, setup);
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
 * not touched. Sub agents go first, since a sub's report would otherwise wake its stopped main again. A stopped run
 * reports nothing. Returns the names stopped, `name` last; an unknown name stops nothing.
 */
export async function stopAgents(source: AgentsStopper, context: Context = BACKGROUND_CONTEXT, name?: string): Promise<string[]> {
  const agents = Object.entries((await source.snapshot(AgentsDoc, context))?.agents ?? {});
  const found = name === undefined ? undefined : find(Object.fromEntries(agents), name);
  if (name !== undefined && !found) return [];
  const chosen = found ? agents.filter(([each, agent]) => agent.parent === found.name || each === found.name) : agents;
  const order = [...chosen.filter(([, agent]) => agent.role === 'sub'), ...chosen.filter(([, agent]) => agent.role === 'main')];
  for (const [, agent] of order) await (await source.conversation(agent.conversationId, context))?.abort(context);
  return order.map(([each]) => each);
}

/** Every spawned agent with its role, parent, conversation, and busy state. */
export async function listAgents(source: DocumentReader, context: Context = BACKGROUND_CONTEXT): Promise<AgentInfo[]> {
  const registry = await source.snapshot(AgentsDoc, context);
  return Promise.all(Object.entries(registry?.agents ?? {}).map(async ([name, agent]) => ({
    name, role: agent.role, parent: agent.parent, conversationId: agent.conversationId,
    busy: await busyOf(source, agent.conversationId, context), standing: agent.standing === true,
  })));
}

/** An input entry's own text, from its data: `[from X] text` or `[X] text`, never the view preamble. */
function inputText(entry: EntryRecord): string | undefined {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  if (entry.kind === MESSAGE_KIND && typeof data.from === 'string' && typeof data.text === 'string') return `[from ${data.from}] ${data.text}`;
  if (entry.kind === REPORT_KIND && typeof data.name === 'string' && typeof data.text === 'string') return `[${data.name}] ${data.text}`;
  return undefined;
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
  source: AgentsSource, name: string, context: Context = BACKGROUND_CONTEXT, page?: number,
): Promise<string> {
  const registry = await source.snapshot(AgentsDoc, context);
  const agent = String(name).toLowerCase() === PI.toLowerCase()
    ? { name: PI, conversationId: ROOT_CONVERSATION_ID } : find(registry?.agents ?? {}, name);
  if (!agent) throw new Error(`No agent named ${name}`);
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const scanned = await source.commit((tx) => tx.scanEntries(
      { conversationId: agent.conversationId, order: 'ascending' }, 256, cursor), context);
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
  const all = lines.join('\n\n');
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
    'You can start background agents ("main agents") with spawn_agent(name, task), and use list_agents, send_message(to, text), last_message(name), and stop_agent(name) to steer them.',
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

/** Pi's lines about the standing agents: who they are and what each is for, so Pi sends work to them. */
function standingText(roster: Roster): string[] {
  const names = Object.keys(roster);
  if (!names.length) return [];
  const purpose = (name: string, agent: StandingAgent) => PURPOSES[name]
    ?? (agent.instructions ? brief(agent.instructions, 80) : agent.tools.length ? `tools: ${agent.tools.join(', ')}` : 'general work');
  return [
    `Standing agents always exist, each with its own model and tools: ${Object.entries(roster).map(([name, agent]) => `${name} (${purpose(name, agent)})`).join('; ')}.`,
    'Send work in their field to them with send_message(name, task) instead of spawning a new agent; spawn other agents only for work none of them fits.',
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
  /** Called after an input from an agent was durably admitted to Pi, at most once per input. */
  readonly onReport?: (report: AgentReport) => unknown;
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
 * - `onReport({ name, text })` is called after an input from agent `name` was durably admitted to
 *   Pi (a final report or a send_message). At most once per input; the durable record is the
 *   `agents.report` entry itself.
 * - `childAgent` is an AgentChange applied to every spawned agent after it copies Pi's choices.
 * - `roster` and `kits`: the standing agents and the tool kits (ADR 0027), as `syncAgents()` takes them. The roster
 *   names the standing agents in Pi's role text and adds each one's `instructions` to its own.
 */
export function createAgentsExtension(options: AgentsOptions = {}): AgentsExtension {
  const { initialContext, onReport, roster = {} } = options;
  // Carries one input to one agent, then that agent's answer to its parent.
  const Deliver = defineTask<DeliveryInput, DeliverState, null>({
    name: 'agents.deliver',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { to, conversationId, content, entry, whenBusy } = task.input;
        const done = (): NextTaskState<DeliverState, null> => ({ status: 'terminal', outcome: { status: 'completed', result: null } });
        const conversation = await runtime.conversation(conversationId, context);
        if (!conversation) return runtime.commit(done, context);
        // A report carries its delivery's id, so memory logs each report once, even identical ones.
        const placed = entry.kind === REPORT_KIND ? { ...entry, data: { ...entry.data, id: task.id } } : entry;
        const submission = await conversation.submit({
          type: 'input', content, entry: placed, whenBusy, requestId: `agents:${task.id}`,
        }, context);
        if (conversationId === ROOT_CONVERSATION_ID) {
          await runtime.commit(done, context);
          // Pi is only ever delivered reports.
          try { if (entry.kind === REPORT_KIND) await onReport?.({ name: entry.data.name, text: entry.data.text, id: task.id }); }
          catch (error) { runtime.report(error); }
          return;
        }
        const settled = await submission.wait(context);
        // One commit records the answer as reported and creates its delivery to the parent.
        await runtime.commit(async (tx) => {
          let report: string | undefined;
          const answer = settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined;
          const answerEntry = answer && await tx.entry(AssistantEntry, answer);
          const registry = await tx.doc(AgentsDoc);
          const agent = registry.agents[to];
          if (!agent) return done();
          if (settled.status === 'unanswered') {
            // As upstream, a failed run reports why; a stopped (aborted) one reports nothing: its stopper knows.
            const detail = typeof settled.detail === 'string' && settled.detail ? `: ${settled.detail}` : '';
            if (settled.reason !== 'aborted') report = `failed: ${settled.reason}${detail}`;
          } else if (answer && !agent.reported.includes(answer)) {
            agent.reported.push(answer);
            if (agent.reported.length > KEEP_REPORTED) agent.reported.splice(0, agent.reported.length - KEEP_REPORTED);
            // As upstream, every answered run reports, even with an empty reply, so the parent learns it ended.
            report = assistantText(answerEntry).trim() || '(no reply)';
          }
          if (report !== undefined) {
            const parent = agent.parent === PI ? ROOT_CONVERSATION_ID : registry.agents[agent.parent]?.conversationId;
            const content = agent.parent === PI ? piReportText(to, report) : `[${to}] ${report}`;
            if (parent) await createDelivery(tx, parent, agent.parent, content,
              { kind: REPORT_KIND, data: { name: to, text: report } }, 'followUp');
          }
          return done();
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const createDelivery = (tx: Tx, conversationId: ConversationId, to: string, content: string,
    entry: MessageEntry | ReportEntry, whenBusy: DeliveryInput['whenBusy']): Promise<TaskId<null>> =>
    tx.createTask(Deliver, { to, conversationId, content, entry, whenBusy }, TASK_OPTIONS);

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
    parameters: Type.Object({
      name: Type.String({ description: 'Unique short name: a letter, then letters, digits, _ or -, at most 32 characters.' }),
      task: Type.String({ description: 'What the agent should do.' }),
    }),
    replay: 'safe',
    execute: async ({ name, task }, api, context) => {
      const caller = await me(api, context);
      if (!caller || caller.role === 'sub') return reply('Sub agents cannot spawn agents.');
      const role = caller.role === 'root' ? 'main' : 'sub';
      if (!isAgentName(name)) {
        return reply('Invalid name: use a letter, then up to 31 letters, digits, _ or -, and not "Pi".');
      }
      const recorded = (await api.snapshot(AgentsDoc, context))?.calls?.[api.taskId];
      const preamble = recorded === undefined && initialContext
        ? await initialContext({ name, role, parent: caller.name, task }, api, context) : undefined;
      const content = `${preamble ? `${preamble}\n\n` : ''}[from ${caller.name}] ${task}`;
      return once(api, context, async (tx, registry) => {
        const existing = find(registry.agents, name);
        if (existing) return `An agent named ${existing.name} already exists; use send_message.`;
        const anchor = await tx.createTask(Anchor, null, TASK_OPTIONS);
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
        registry.agents[name] = { conversationId: child.id, role, parent: caller.name, reported: [] };
        await deriveAgent(tx, registry.agents, name, options);
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
      const others: { name: string; role: string; conversationId: ConversationId }[] = [
        ...(caller.role === 'main' ? [{ name: PI, role: 'session agent', conversationId: ROOT_CONVERSATION_ID }] : []),
        ...Object.entries(registry?.agents ?? {}).filter(([name]) => name !== caller.name)
          .map(([name, agent]) => ({ name, ...agent, role: `${agent.role}, parent ${agent.parent}${agent.standing ? ', standing' : ''}` })),
      ];
      if (!others.length) return reply('No other agents.');
      const last = await api.commit(async (tx) => {
        const answers: Record<string, string | undefined> = {};
        for (const agent of others) answers[agent.name] = await lastAnswer(tx, agent.conversationId);
        return answers;
      }, context);
      const lines = await Promise.all(others.map(async (agent) => {
        const state = await busyOf(api, agent.conversationId, context) ? 'busy' : 'idle';
        const answer = last[agent.name];
        const said = answer === undefined ? 'no message yet' : `last: ${brief(answer)}`;
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
        if ('error' in found) return found.error;
        if (found.name === caller.name) return 'You cannot message yourself.';
        const entry: MessageEntry | ReportEntry = found.role === 'root'
          ? { kind: REPORT_KIND, data: { name: caller.name, text: message } }
          : { kind: MESSAGE_KIND, data: { from: caller.name, text: message } };
        const content = found.role === 'root' ? piReportText(caller.name, message) : `[from ${caller.name}] ${message}`;
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
      if ('error' in found) return reply(found.error);
      const said = await api.commit((tx) => lastAnswer(tx, found.conversationId), context);
      const state = await busyOf(api, found.conversationId, context) ? 'busy' : 'idle';
      return reply(`${found.name} is ${state}. ${said === undefined ? 'No message yet.' : `Last message:\n${said}`}`);
    },
  });

  const stopAgent = defineTool({
    name: 'stop_agent',
    description: 'Stop an agent\'s current work and drop its queued messages; stopping a main agent also stops its sub agents. '
      + 'Stopped agents stay and can be messaged again. Pi may stop any agent; a main agent only its own sub agents.',
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
      const subs = (await stopAgents(api, context, found.name)).slice(0, -1);
      const also = subs.length ? ` and its sub agents ${subs.join(', ')}` : '';
      const untold = found.parent === caller.name ? '' : ` Its main agent ${found.parent} is not told; message it if it should know.`;
      return reply(`Stopped ${found.name}${also}.${untold}`);
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

  // Typed as AgentsExtension rather than through defineExtension (an identity), so `tools` stays required.
  return {
    name: 'agents',
    tasks: [Anchor, Deliver],
    tools: [spawnAgent, listAgentsTool, sendMessage, lastMessage, stopAgent],
    hooks: [guard],
    sections: [section('agents', async (input, context) => {
      const caller = whoIs(await input.read.snapshot(AgentsDoc, context), input.conversationId);
      if (!caller) return undefined;
      // Without initialContext no view precedes the task, so the text about it is left out.
      const lines = ROLE_TEXT[caller.role](caller).filter((line) => initialContext || line !== VIEW_TEXT);
      if (caller.role === 'root') lines.push(...standingText(roster));
      const own = caller.role === 'main' && caller.standing ? rosterEntry(roster, caller.name) : undefined;
      if (own?.instructions) lines.push(own.instructions);
      return lines.join('\n');
    })],
  };
}
