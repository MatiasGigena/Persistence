// Chat wording both front ends show, from protocol values: tool-call summaries, agent archive prompts and results,
// the /status block, zoom output. No DOM, Node or pi-tui, so the terminal UI imports it and the server hands it to
// the browser at /ui/text.ts (ADR 0020). Rendering (color, width, markup) stays with each front end.
import { ARCHIVE_TTL_MS } from '../protocol/messages.ts';
import { isRecord } from '../protocol/util.ts';
import type { ScheduleStatus, SearchHit, SessionStatus, UsageReport, UsageRow, ViewLine } from '../protocol/session.ts';

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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * A time as a client shows it, in the client's own zone, read against `now`: "today 09:00", "tomorrow 09:00",
 * "Thu 12 Nov 09:00", with the year when it is another one.
 */
export function whenText(at: number, now: number): string {
  const date = new Date(at), today = new Date(now);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const midnight = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(today)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${WEEKDAYS[date.getDay()] ?? ''} ${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}${year} ${time}`;
}

/** When a schedule fires: "today 09:00", or for a repeating one "cron 0 9 * * 1-5 · next today 09:00". */
export function scheduleWhen(schedule: Pick<ScheduleStatus, 'at' | 'cron'>, now: number): string {
  const when = whenText(schedule.at, now);
  return schedule.cron === undefined ? when : `cron ${schedule.cron} · next ${when}`;
}

/** What /schedule prints: one line per scheduled wake-up, soonest first, and how to cancel one. */
export function schedulesText(schedules: readonly ScheduleStatus[], now: number): string {
  if (!schedules.length) return 'No schedules. Ask Pi to remind you of something, or to check back on it later.';
  return [...schedules.map(each => `#${each.id} · ${scheduleWhen(each, now)} · ${each.text}`),
    '/schedule cancel N cancels one; ask Pi for a new one.'].join('\n');
}

const TOKEN_UNITS = ['k', 'M', 'B', 'T'];

/** A token count in at most three digits and a unit: 999, 1.2k, 80.4k, 900k, 1.2M, 3.4B. */
export function tokenCount(count: number): string {
  let value = Math.round(count), unit = -1;
  const shown = (): number => value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  while (shown() >= 1000 && unit < TOKEN_UNITS.length - 1) { value /= 1000; unit++; }
  return `${shown()}${TOKEN_UNITS[unit] ?? ''}`;
}

/**
 * A cost in US dollars, to the cent: "$4.21"; "<$0.01" for less than half a cent; '' for none, which is what a
 * provider that prices nothing reports (claude-cli, on a plan).
 */
export const costText = (cost: number): string => cost <= 0 ? '' : cost < 0.005 ? '<$0.01' : `$${cost.toFixed(2)}`;

/** A usage row without its model: a period's sum is one. */
export type UsageCounts = Omit<UsageRow, 'model'>;

/** The periods of a usage report, in the order shown, with their labels. */
export const USAGE_PERIODS: readonly (readonly [key: 'today' | 'week' | 'all', label: string])[] = [
  ['today', 'today'], ['week', '7 days'], ['all', 'all time'],
];

/** The sum of a period's rows. */
export function usageSum(rows: readonly UsageCounts[]): UsageCounts {
  return rows.reduce<UsageCounts>((sum, row) => ({
    input: sum.input + row.input, output: sum.output + row.output, cacheRead: sum.cacheRead + row.cacheRead,
    cacheWrite: sum.cacheWrite + row.cacheWrite, cost: sum.cost + row.cost,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
}

/** A row's tokens: "in 1.2M · out 80.4k · cache 3.4M read, 210k written"; the cache part names only what was used. */
export function usageTokens(row: UsageCounts): string {
  const cache = [row.cacheRead ? `${tokenCount(row.cacheRead)} read` : '', row.cacheWrite ? `${tokenCount(row.cacheWrite)} written` : ''].filter(Boolean);
  return [`in ${tokenCount(row.input)}`, `out ${tokenCount(row.output)}`, ...cache.length ? [`cache ${cache.join(', ')}`] : []].join(' · ');
}

/** What a usage report ends with: what its costs are, and since when its days are counted (in the client's zone). */
export function usageNote(report: Pick<UsageReport, 'since'>, now: number): string {
  return 'Costs are catalog prices; on a subscription plan they are not what you pay.'
    + (report.since === undefined ? '' : ` Daily counting began ${whenText(report.since, now)}.`);
}

/**
 * What /usage prints: per period its sum, then one indented line per model, the most tokens first, each with its cost
 * when it has one; "nothing yet" for a period without spend; then `usageNote`.
 */
export function usageText(report: UsageReport, now: number): string {
  const width = Math.max(0, ...USAGE_PERIODS.flatMap(([key]) => report[key].map(row => row.model.length)));
  const spend = (row: UsageCounts): string => [usageTokens(row), costText(row.cost)].filter(Boolean).join(' · ');
  return [...USAGE_PERIODS.flatMap(([key, label]) => {
    const rows = report[key];
    return [`${label.padEnd(9)}${rows.length ? spend(usageSum(rows)) : 'nothing yet'}`, ...rows.map(row => `  ${row.model.padEnd(width)}  ${spend(row)}`)];
  }), usageNote(report, now)].join('\n');
}

/** How to search, for /find without words and a search that found nothing. */
export const SEARCH_USAGE = 'Search the log: /find words, with "a phrase" in double quotes, and kind:user (or pi, tool, echo, work, note) for one kind.';

/** Under a search that found nothing. */
export const SEARCH_HINT = 'Try other words, "a phrase" in quotes, or kind:user.';

/** A search hit's label: `#1234 · Thu 12 Nov 09:00 · user`, the time in the client's own zone, read against `now`. */
export function hitLabel(hit: Pick<SearchHit, 'id' | 'kind' | 'date'>, now: number): string {
  return `#${hit.id} · ${whenText(Date.parse(hit.date), now)} · ${hit.kind}`;
}

/**
 * What heads a search's results: `12 matches for "deploy"`, `50 of 312 matches for "deploy" (newest first)` when only
 * `shown` of them are listed, or `No message matches "deploy".`. A query with a quoted phrase shows as typed.
 */
export function searchHeader(query: string, shown: number, total: number): string {
  const line = oneLine(query), asked = line.includes('"') ? line : `"${line}"`;
  if (!total) return `No message matches ${asked}.`;
  if (shown < total) return `${shown} of ${total} matches for ${asked} (newest first)`;
  return `${total} ${total === 1 ? 'match' : 'matches'} for ${asked}`;
}

/** The full status block that /status prints, in the terminal and the web app. */
export function statusText(status: SessionStatus, now: number = Date.now()): string {
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
  const [next] = status.schedules ?? [];
  if (next) lines.push(`schedules ${status.schedules?.length ?? 0} · next #${next.id} ${whenText(next.at, now)}`);
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

/** A size in bytes, readably. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit] ?? ''}`;
}
