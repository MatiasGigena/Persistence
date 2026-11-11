import { section } from '@earendil-works/pi-durable';
import { AUTOREVIEW_POLICY, rosterEntry } from './roster.ts';
import { AgentsDoc, whoIs, Anchor, standingOf, confined } from './registry.ts';
import { VIEW_TEXT, ROLE_TEXT, CONFINED_TEXT, standingText } from './prompts.ts';
import type { AgentsOptions, AgentsExtension } from './setup.ts';
import { deliveries } from './delivery.ts';
import { spawnAgentTool, delegateTool, listAgentsTool, sendMessageTool, lastMessageTool, stopAgentTool, deleteAgentTool, agentsGuard } from './tools.ts';
import type { ToolDeps } from './tools.ts';

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
 * The host wiring is openInstance in src/runtime/runtime.ts: it installs the extension (inspect-only launches too, so
 * the tasks stay known), configures Pi with it, and calls syncAgents on every work launch before resuming the harness.
 * Pi is always ROOT_CONVERSATION_ID; nothing else needs configuring and no settings are required.
 * Every input reaching Pi (a main agent's final report or its send_message) is the user message
 * `piReportText(name, text)`, placed as the entry `{ kind: 'agents.report', data: { name, text, id } }`; inputs to
 * other agents are `agents.message` (`[from Name] text`, data `{ from, text }`) or `agents.report`.
 * Pi's answers to them are ordinary root runs that no `submission.wait()` of the host awaits, so a
 * host that prints answers must watch the root. Deliveries are background tasks: `root.waitForIdle()`
 * and Pi's Esc (`root.abort()`) do not reach them; `root.abort(ctx, { background: true })` does.
 *
 * The modules: registry.ts (the AgentsDoc registry, the Anchor task and the lookups every part shares), setup.ts (how
 * an agent's choices derive from Pi's and the roster: syncAgents), delivery.ts (the Deliver task), lifecycle.ts (stop,
 * delete, archive, restore, purge), transcript.ts (zoom("Name")), prompts.ts (the role texts), tools.ts (the agent
 * tools and their guard), and this file, which builds the extension and is the package's public API.
 */

export { DEFAULT_ROSTER } from './roster.ts';
export type { Kit, Roster, StandingAgent } from './roster.ts';
export { agentInputOf, assistantText, MESSAGE_KIND, REPORT_KIND, text } from './entries.ts';
export type { AgentInput } from './entries.ts';
export { AgentsDoc, ARCHIVE_TTL_MS, listAgents, PI, piReportText } from './registry.ts';
export type { AgentInfo, AgentRecord, AgentReport, AgentRole, AgentsSource, AgentsState, AgentsStopper, MessageEntry, ReportEntry } from './registry.ts';
export { missingKits, syncAgents } from './setup.ts';
export type { AgentsExtension, AgentsOptions, AgentsSetup, ToolKit, ToolKits } from './setup.ts';
export { archiveAgents, deleteAgent, deleteText, purgeArchived, restoreAgent, stopAgents } from './lifecycle.ts';
export type { DeleteResult } from './lifecycle.ts';
export { agentTranscript, TRANSCRIPT_PAGE } from './transcript.ts';

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
  const { initialContext, roster = {} } = options;
  const { Deliver, createDelivery } = deliveries(options);
  const deps: ToolDeps = { options, roster, createDelivery };

  // Typed as AgentsExtension rather than through defineExtension (an identity), so `tools` stays required.
  return {
    name: 'agents',
    tasks: [Anchor, Deliver],
    tools: [spawnAgentTool(deps), delegateTool(deps), listAgentsTool(), sendMessageTool(deps), lastMessageTool(), stopAgentTool(),
      deleteAgentTool(deps)],
    hooks: [agentsGuard(roster)],
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
