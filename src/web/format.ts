// Text helpers of the web app with no DOM: the header status line, sheet headers, pairing and load wording. The
// wording both front ends share is in src/ui/text.ts. Also `inOrder`, which keeps attached images in the order they
// were picked, here so Node tests reach it.
import type { MemoryStats, ModelChoice, SessionStatus, ViewLine } from '../protocol/messages.ts';
import { activeAgents, modelRef, size } from '../ui/text.ts';

/** Arguments for the expanded tool view: pretty JSON when they parse, else as they streamed. */
export function prettyArgs(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    return JSON.stringify(parsed, null, 2) ?? args;
  } catch {
    return args;
  }
}

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
  const agents = activeAgents(status.agents);
  if (agents.length) {
    const busy = agents.filter(agent => agent.busy).length;
    parts.push({ key: 'agents', text: `${busy}/${agents.length} agents`, tone: busy ? 'busy' : 'dim' });
  }
  return parts;
}

/** The memory sheet's header: messages, view size, summaries in flight, failures. */
export function memoryHeader(memory: MemoryStats | undefined): string {
  if (!memory) return 'Memory off';
  return `${memory.messages} messages · ${(memory.viewBytes / 1024).toFixed(1)} KB view · ${memory.active} summarizing · ${memory.failed} failed`;
}

export const lineLabel = (line: ViewLine): string => `${line.id}+${line.n}`;

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
export function formatCodeInput(input: string): string {
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
