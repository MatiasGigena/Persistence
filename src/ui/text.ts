// Chat wording both front ends show, from protocol values: tool-call summaries, agent archive prompts and results,
// the /status block, zoom output. No DOM, Node or pi-tui, so the terminal UI imports it and the server hands it to
// the browser at /ui/text.ts (ADR 0020). Rendering (color, width, markup) stays with each front end.
import { ARCHIVE_TTL_MS } from '../protocol/messages.ts';
import { isRecord } from '../protocol/util.ts';
import type { SessionStatus, ViewLine } from '../protocol/session.ts';

// Control characters other than newline and tab, and terminal escapes, never reach the summary.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** `text` on one line, without control characters or terminal escapes. */
export const oneLine = (text: string): string => text.replace(CONTROL, '').replace(/\s+/g, ' ').trim();

/** The argument that says what a call does, by tool name; zoom is handled on its own. */
const SUMMARY_KEY: Readonly<Record<string, string>> = {
  bash: 'command', read: 'path', write: 'path', edit: 'path',
  spawn_agent: 'name', send_message: 'to', last_message: 'name', stop_agent: 'name', delete_agent: 'name', delegate: 'agent',
};

/** Longest compact-JSON summary, for tools without a known argument. */
const SUMMARY_JSON = 60;

/** A string field of possibly partial JSON (arguments stream in), or undefined. */
function field(args: string, key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) return undefined;
    const value = parsed[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  } catch {
    const match = new RegExp(`"${key}"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)|(\\d+))`).exec(args);
    const raw = match?.[1];
    return raw === undefined ? match?.[2] : unescape(raw);
  }
}

/** A JSON string's body without its escapes; as is when it does not parse (cut mid-escape). */
function unescape(raw: string): string {
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === 'string' ? value : raw;
  } catch {
    return raw;
  }
}

/**
 * One meaningful argument of a tool call, on one line: bash its command,
 * read/write/edit the path, zoom `id+n`, agent tools the agent's name; any other tool its compact JSON, truncated.
 */
export function toolSummary(name: string, args: string): string {
  if (name === 'zoom') {
    const id = field(args, 'id');
    if (id !== undefined) return /^\d+$/.test(id) ? `${id}+${field(args, 'n') ?? '1'}` : oneLine(id);
  }
  const key = SUMMARY_KEY[name];
  const value = key === undefined ? undefined : field(args, key);
  if (value !== undefined) return oneLine(value);
  const json = [...oneLine(args)];
  if (json.join('') === '{}') return '';
  return json.length > SUMMARY_JSON ? `${json.slice(0, SUMMARY_JSON - 1).join('')}…` : json.join('');
}

/** A bash call's command as written, newlines kept, for its copyable block; undefined for any other tool. */
export function toolCommand(name: string, args: string): string | undefined {
  return name === 'bash' ? field(args, 'command') : undefined;
}

/** A byte count as B, KB or MB. */
export const size = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "provider/id": what SessionStatus.model shows. */
export const modelRef = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`;

/** The agents at work: those not archived. Counts, lists and busy marks read only these. */
export function activeAgents<T extends { readonly archivedAt?: number }>(agents: readonly T[]): T[] {
  return agents.filter(agent => agent.archivedAt === undefined);
}

/** The archived agents, soonest deleted first. */
export function archivedAgents<T extends { readonly archivedAt?: number }>(agents: readonly T[]): (T & { readonly archivedAt: number })[] {
  return agents.flatMap(agent => (agent.archivedAt === undefined ? [] : [{ ...agent, archivedAt: agent.archivedAt }]))
    .sort((a, b) => a.archivedAt - b.archivedAt);
}

/**
 * When an agent archived at `archivedAt` (ms) is deleted, from `now`: "deleted in 5 h" (whole hours, rounded down),
 * "deleted in 12 min" under an hour (rounded up), "deleted soon" once due.
 */
export function deletionText(archivedAt: number, now: number): string {
  const left = archivedAt + ARCHIVE_TTL_MS - now;
  if (left <= 0) return 'deleted soon';
  const hours = Math.floor(left / 3_600_000);
  return hours >= 1 ? `deleted in ${hours} h` : `deleted in ${Math.ceil(left / 60_000)} min`;
}

/**
 * Whether the status marks an agent as standing (ADR 0027). Read structurally, so a status without the field counts
 * every agent as ad-hoc; the server still refuses to archive a standing one.
 */
/** The main agents "archive all ad-hoc agents" takes: not archived, not standing. */
export function adhocAgents<T extends { readonly role: string; readonly archivedAt?: number; readonly standing?: true }>(agents: readonly T[]): T[] {
  return activeAgents(agents).filter(agent => agent.role === 'main' && !agent.standing);
}

/** Asked before archiving one agent; `subs` are its sub agents, which go with it. */
export function archiveQuestion(name: string, subs: readonly string[] = []): string {
  return `Archive ${name}? It stops now and is deleted in 24 h; restore within the day.`
    + (subs.length ? ` Its sub agents go with it: ${subs.join(', ')}.` : '');
}

/** Asked before archiving every ad-hoc main agent, named. */
export function archiveAdhocQuestion(names: readonly string[]): string {
  return `Archive all ad-hoc agents: ${names.join(', ')}? They and their sub agents stop now and are deleted in 24 h;`
    + ' restore within the day. Standing agents stay.';
}

/** What archiving or restoring did, from the names the server returns. */
export function archivedText(names: readonly string[], restored = false): string {
  if (!names.length) return restored ? 'Nothing to restore.' : 'No agents to archive.';
  return `${restored ? 'Restored' : 'Archived'} ${names.join(', ')}.`;
}

/** The full status block that /status prints, in the terminal and the web app. */
export function statusText(status: SessionStatus): string {
  const { memory } = status;
  const agents = activeAgents(status.agents), archived = status.agents.length - agents.length;
  const lines = [
    `model ${status.model} · thinking ${status.thinkingLevel} · tools ${status.toolsEnabled ? 'on' : 'off'}`,
    ...status.machine ? [`tools run on ${status.machine.label} in ${status.machine.cwd}`] : [],
    `work ${status.busy ? 'running' : 'idle'}${status.queued ? ` · ${status.queued} queued` : ''}`,
    memory ? `memory ${memory.messages} msgs · ${memory.unsummarized} unsummarized · view ${memory.viewLines} lines, ${memory.viewBytes} bytes`
      + ` · ${memory.active} summarizing · ${memory.failed} failed` : 'memory closed',
  ];
  if (memory?.lastError) lines.push(`memory error: ${memory.lastError}`);
  lines.push(agents.length
    ? `agents ${agents.map(agent => `${agent.name} (${agent.role}, ${agent.busy ? 'busy' : 'idle'})`).join(', ')}`
    : 'agents none');
  if (archived) lines.push(`archived ${archived}`);
  return lines.join('\n');
}

/** The two lines `zoom(id, n > 1)` returns, as `id+n|text`. Lines that do not parse are skipped. */
export function parseZoom(out: string): ViewLine[] {
  return out.split('\n').flatMap(line => {
    const m = /^(\d+)\+(\d+)\|(.*)$/.exec(line);
    return m ? [{ id: Number(m[1]), n: Number(m[2]), text: m[3] ?? '' }] : [];
  });
}

/** `zoom(id, 1)`: `id+1|kind: text`, or `id+1 (page …)|…` for a long message, whose page note is kept. */
export function parseMessage(out: string): { note: string | undefined; body: string } {
  const bar = out.indexOf('|');
  if (bar < 0) return { note: undefined, body: out };
  const head = out.slice(0, bar), paren = head.indexOf(' (');
  return { note: paren < 0 ? undefined : head.slice(paren + 1), body: out.slice(bar + 1) };
}
