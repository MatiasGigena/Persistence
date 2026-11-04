// How an agent's stored choices derive from Pi's (model, tools, instructions), then from its roster entry for a
// standing agent: deriveAgent, the standing agents' creation, and syncAgents on every work launch.
import type { Context, Draft } from '@earendil-works/chord';
import { copyJson } from '@earendil-works/chord';
import { AgentDoc, ROOT_CONVERSATION_ID, configure } from '@earendil-works/pi-durable';
import type { AgentChange, ConversationId, Extension, Session, ToolExecutionApi, ToolRegistration, Tx } from '@earendil-works/pi-durable';
import type { Kit, Roster } from './roster.ts';
import { LOCAL_KITS, rosterEntry } from './roster.ts';
import { PI, AgentsDoc, findAgent, sessionsOf, Anchor, TASK_OPTIONS, standingOf } from './registry.ts';
import type { AgentRole, AgentRecord, AgentsState, AgentReport } from './registry.ts';

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
  /** Each run's tools act on a pinned machine (src/runtime/routing.ts), not this one: the agents' instructions say so. */
  readonly routed?: boolean;
}

/** The agent tools' names (persisted, frozen); a standing agent gets them besides its kits. */
export const AGENT_TOOLS = ['spawn_agent', 'list_agents', 'send_message', 'last_message', 'stop_agent'];

export const SUB_HIDDEN = ['spawn_agent', 'stop_agent'];

/** Pi's alone: agents copy Pi's tools, then lose these. */
export const PI_ONLY = ['delegate', 'delete_agent'];

/** The local tools' safety note, as in Pi's instructions (src/runtime/runtime.ts `piInstructions`). */
export const protectedText = (bash: boolean, routed = false) => `These tools act on ${routed ? 'the pinned machine with its runner permissions' : 'the local machine with the host process permissions'}. Some folders are `
  + 'protected: this chat\'s own state and the user\'s credentials (~/.ssh, ~/.claude, cloud and git logins) cannot be read or changed, the user\'s SSH '
  + `agent is not reachable, and system folders (/etc, /usr, ...) are read-only${bash ? '; bash runs in a sandbox that enforces this' : ''}. A refusal that names a `
  + 'protected path is deliberate: do not try to get around it, and say in your report if the task needs that path. Use the tools '
  + 'only when your task needs them, and do nothing destructive or otherwise sensitive that it does not ask for.';

/**
 * A standing agent's (and its subs') instructions: Pi's, with its line about Pi's coding tools (the one naming bash) replaced
 * by the agent's own tools. `tools` are its kits' tools in force; `local` those of its local kits, `localOn` whether
 * they are on. Pi's instructions name read, write, edit and bash, which an agent without the coding kit must not call.
 */
export function standingInstructions(pi: string | undefined, tools: readonly string[], local: readonly string[], localOn: boolean,
  routed: boolean): string {
  const kept = (pi ?? '').split('\n').filter((line) => line && !/\bbash\b/.test(line));
  const own = tools.length ? `Your tools besides the agent tools: ${tools.join(', ')}. You have no others.`
    : 'You have no tools besides the agent tools.';
  const lines = [...kept, own];
  const usable = localOn ? local : [];
  if (usable.length) lines.push(protectedText(usable.includes('bash'), routed));
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
export async function deriveAgent(tx: Tx, agents: Readonly<Record<string, AgentRecord>>, name: string, { childAgent, roster, kits = {}, routed = false }: AgentsSetup,
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
    state.instructions = standingInstructions(root.instructions, own, local, localOn, routed);
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
export async function ensureStanding(tx: Tx, registry: Draft<AgentsState>, roster: Roster): Promise<void> {
  for (const name of Object.keys(roster)) {
    const existing = findAgent(registry.agents, name);
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
