// Text helpers of the web app with no DOM: tool summaries, the status line, memory zoom parsing, sizes. They
// mirror the terminal UI's wording (src/ui/tui/), which cannot load in a browser; test/web checks the two agree.
// Also `inOrder`, which keeps attached images in the order they were picked, here so Node tests reach it.
import { ARCHIVE_TTL_MS } from '../protocol/messages.ts';
import type { MemoryStats, ModelChoice, SessionStatus, ViewLine } from '../protocol/messages.ts';

// Control characters other than newline and tab, and terminal escapes, never reach the page.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;
export const clean = (text: string): string => text.replace(CONTROL, '');
export const oneLine = (text: string): string => clean(text).replace(/\s+/g, ' ').trim();

/** The argument that says what a call does, by tool name; zoom is handled on its own (as src/ui/tui/chat.ts). */
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
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value: unknown = Object.entries(parsed).find(([name]) => name === key)?.[1];
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
 * One meaningful argument of a tool call, on one line, exactly as the terminal's `toolSummary`: bash its command,
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

/** Arguments for the expanded tool view: pretty JSON when they parse, else as they streamed. */
export function prettyArgs(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    return JSON.stringify(parsed, null, 2) ?? args;
  } catch {
    return args;
  }
}

/** A bash call's command as written, newlines kept, for its copyable block; undefined for any other tool. */
export function toolCommand(name: string, args: string): string | undefined {
  return name === 'bash' ? field(args, 'command') : undefined;
}

export const size = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "provider/id": what SessionStatus.model shows. */
export const modelRef = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`;

/** The model's id without its provider, for the header chip. */
export function shortModel(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** One segment of the header's status line; `tone` picks its color. */
export interface StatusPart {
  readonly key: 'work' | 'queued' | 'memory' | 'failed' | 'agents';
  readonly text: string;
  readonly tone: 'busy' | 'dim' | 'error';
}

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
 * "deleted in 12 min" under an hour (rounded up), "deleted soon" once due. As the terminal's `deletionText`.
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
const isStanding = (agent: object): boolean => 'standing' in agent && Boolean(agent.standing);

/** The main agents "archive all ad-hoc agents" takes: not archived, not standing. */
export function adhocAgents<T extends { readonly role: string; readonly archivedAt?: number }>(agents: readonly T[]): T[] {
  return activeAgents(agents).filter(agent => agent.role === 'main' && !isStanding(agent));
}

/** Asked before archiving one agent; `subs` are its sub agents, which go with it. As the terminal's. */
export function archiveQuestion(name: string, subs: readonly string[] = []): string {
  return `Archive ${name}? It stops now and is deleted in 24 h; restore within the day.`
    + (subs.length ? ` Its sub agents go with it: ${subs.join(', ')}.` : '');
}

/** Asked before archiving every ad-hoc main agent, named. As the terminal's. */
export function archiveAdhocQuestion(names: readonly string[]): string {
  return `Archive all ad-hoc agents: ${names.join(', ')}? They and their sub agents stop now and are deleted in 24 h;`
    + ' restore within the day. Standing agents stay.';
}

/** What archiving or restoring did, from the names the server returns. As the terminal's. */
export function archivedText(names: readonly string[], restored = false): string {
  if (!names.length) return restored ? 'Nothing to restore.' : 'No agents to archive.';
  return `${restored ? 'Restored' : 'Archived'} ${names.join(', ')}.`;
}

/** The compact status under the header: work, queue, memory and agents, in the terminal footer's short forms. */
export function statusParts(status: SessionStatus): StatusPart[] {
  const parts: StatusPart[] = [{ key: 'work', text: status.busy ? 'working' : 'idle', tone: status.busy ? 'busy' : 'dim' }];
  if (status.busy && status.queued) parts.push({ key: 'queued', text: `${status.queued} queued`, tone: 'dim' });
  const { memory } = status;
  if (memory) {
    parts.push({ key: 'memory', text: `mem ${size(memory.viewBytes)}`, tone: 'dim' });
    if (memory.failed) parts.push({ key: 'failed', text: `${memory.failed} failed`, tone: 'error' });
  }
  const agents = activeAgents(status.agents);
  if (agents.length) {
    const busy = agents.filter(agent => agent.busy).length;
    parts.push({ key: 'agents', text: `${busy}/${agents.length} agents`, tone: busy ? 'busy' : 'dim' });
  }
  return parts;
}

/** The full status, as the terminal's /status prints it. */
export function statusText(status: SessionStatus): string {
  const { memory } = status;
  const agents = activeAgents(status.agents), archived = status.agents.length - agents.length;
  const lines = [
    `model ${status.model} · thinking ${status.thinkingLevel} · tools ${status.toolsEnabled ? 'on' : 'off'}`,
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

/** The memory sheet's header: messages, view size, summaries in flight, failures. */
export function memoryHeader(memory: MemoryStats | undefined): string {
  if (!memory) return 'Memory off';
  return `${memory.messages} messages · ${(memory.viewBytes / 1024).toFixed(1)} KB view · ${memory.active} summarizing · ${memory.failed} failed`;
}

export const lineLabel = (line: ViewLine): string => `${line.id}+${line.n}`;

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

/** The current model first, then available, then unavailable: the terminal picker's order. */
export function sortModels(models: readonly ModelChoice[], current: string): ModelChoice[] {
  const rank = (m: ModelChoice): number => (modelRef(m) === current ? 0 : m.available ? 1 : 2);
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/** Bytes of a base64url string (a VAPID key), for `applicationServerKey`. */
export function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A pairing code as typed: Crockford base32 upper-cased (I and L read as 1, O as 0), as `XXXX-XXXX`. */
export function normalizeCode(input: string): string {
  const chars = input.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[^0-9A-HJKMNP-TV-Z]/g, '').slice(0, 8);
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

const PAIR_ERRORS: Readonly<Record<number, string>> = {
  400: 'That code is not in the right shape: 8 characters, like 7KQ4-M2XD.',
  401: 'That code is wrong or has expired. Run pi-durable serve pair for a new one.',
  409: 'A device with that name is already paired. Pick another name.',
  429: 'Too many tries. Run pi-durable serve pair for a new code.',
};

/**
 * What the pairing screen says when `/api/pair` answers `status`, with the body's `error` (a 403 says which check
 * refused: retrying cannot help with either).
 */
export function pairErrorText(status: number, reason: unknown): string {
  if (status === 403 && reason === 'origin') return 'This address is not the server\'s PI_DURABLE_ORIGIN. Open the app at that address to pair.';
  if (status === 403 && reason === 'login') return 'This Tailscale login is not allowed: the server lets in only PI_DURABLE_ALLOW_LOGIN.';
  return PAIR_ERRORS[status] ?? `The server answered ${status}. Try again.`;
}

/** A default device name from the user agent, e.g. "iPhone" or "Android phone". */
export function guessDeviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows PC';
  if (/Linux/.test(userAgent)) return 'Linux PC';
  return 'Browser';
}

// ------------------------------------------------------------------------------------------------ the first load

/** The loading rule's marks: under QUIET nothing new shows; until SLOW a skeleton; past it, a skeleton and a line. */
export const LOAD_QUIET_MS = 300;
export const LOAD_SLOW_MS = 1_500;

/** What the link is doing, as one line (the banner's); `retry` when "Retry now" can start an attempt at once. */
export const LINK_TEXT = {
  connecting: { text: 'Connecting…', retry: false },
  reconnecting: { text: 'Reconnecting…', retry: true },
  offline: { text: 'Offline. Connect to Tailscale; retrying.', retry: true },
} as const;

/** What the first load shows: the chat's skeleton or still the boot screen, and its line ('' for none). */
export interface LoadStep {
  readonly skeleton: boolean;
  readonly text: string;
  readonly retry: boolean;
}

/**
 * The first load, `elapsed` ms after `/api/me` let the app in, before the first `ready`: the boot screen at first, so
 * a quick load goes straight to the finished chat; then the chat's skeleton; then the skeleton and a short line, the
 * link's own (connecting, or reconnecting after a failed attempt). Offline skips the wait: nothing is coming soon, so
 * the skeleton and the reason show at once.
 */
export function loadStep(elapsed: number, state: keyof typeof LINK_TEXT): LoadStep {
  const skeleton = state === 'offline' || elapsed >= LOAD_QUIET_MS;
  const line = state === 'offline' || elapsed >= LOAD_SLOW_MS ? LINK_TEXT[state] : undefined;
  return { skeleton, text: line?.text ?? '', retry: line?.retry ?? false };
}

/** What `inOrder` hands on for one item: its value, or why it failed. */
export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Reads every item of `items` at once, and hands each result to `settle` in the items' order, not in the order the reads
 * finish: the photo picked first stays first, however long it takes to scale. `after` is an earlier batch's chain, so a
 * later batch never lands ahead of it. Returns this batch's chain.
 */
export function inOrder<T, R>(items: readonly T[], read: (item: T) => Promise<R>, settle: (result: Settled<R>) => void,
  after: Promise<void> = Promise.resolve()): Promise<void> {
  let chain = after;
  for (const item of items) {
    const result = read(item).then((value): Settled<R> => ({ ok: true, value }), (error: unknown): Settled<R> => ({ ok: false, error }));
    chain = chain.then(() => result).then(settle);
  }
  return chain;
}
