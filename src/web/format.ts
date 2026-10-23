// Text helpers of the web app with no DOM: tool summaries, the status line, memory zoom parsing, sizes. They
// mirror the terminal UI's wording (src/ui/tui/), which cannot load in a browser; test/web checks the two agree.
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

/** The compact status under the header: work, queue, memory and agents, in the terminal footer's short forms. */
export function statusParts(status: SessionStatus): StatusPart[] {
  const parts: StatusPart[] = [{ key: 'work', text: status.busy ? 'working' : 'idle', tone: status.busy ? 'busy' : 'dim' }];
  if (status.busy && status.queued) parts.push({ key: 'queued', text: `${status.queued} queued`, tone: 'dim' });
  const { memory } = status;
  if (memory) {
    parts.push({ key: 'memory', text: `mem ${size(memory.viewBytes)}`, tone: 'dim' });
    if (memory.failed) parts.push({ key: 'failed', text: `${memory.failed} failed`, tone: 'error' });
  }
  if (status.agents.length) {
    const busy = status.agents.filter(agent => agent.busy).length;
    parts.push({ key: 'agents', text: `${busy}/${status.agents.length} agents`, tone: busy ? 'busy' : 'dim' });
  }
  return parts;
}

/** The full status, as the terminal's /status prints it. */
export function statusText(status: SessionStatus): string {
  const { memory, agents } = status;
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

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
