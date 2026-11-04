import { createHash } from 'node:crypto';

export const NODE = 512;      // bytes per tree node (recipe §2)
export const CAP = 30_000;    // characters: tool output is clipped to this, other text split at it (§1)

export const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** One line: each newline and the whitespace around it become one space (UniiChat Memory.ts `flat`). */
export const flat = (s: string): string => /[\r\n]/.test(s) ? s.replace(/\s*[\r\n]\s*/g, ' ') : s;
export const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const highSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** Tool output: head and tail around a marker, at most `limit` characters in all (as UniiChat Clip.ts keeps 64 per half for it). */
export function clip(text: string, limit = CAP): string {
  if (text.length <= limit) return text;
  const keep = limit / 2 - 64;
  let head = keep, tail = text.length - keep;
  if (highSurrogate(text.charCodeAt(head - 1))) head--;
  if (highSurrogate(text.charCodeAt(tail - 1))) tail++;
  return `${text.slice(0, head)}\n[… ${tail - head} characters clipped …]\n${text.slice(tail)}`;
}

/** Other long text is never cut: parts of at most `limit` characters, at the last newline when there is one. */
export function split(text: string, limit = CAP): string[] {
  const parts: string[] = [];
  while (text.length > limit) {
    let end = limit;
    if (highSurrogate(text.charCodeAt(end - 1))) end--;
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl > 0) end = nl + 1;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  parts.push(text);
  return parts;
}

/** The longest prefix of `s` within `limit` UTF-8 bytes, never half a character. */
export function cutBytes(s: string, limit: number): string {
  if (bytes(s) <= limit) return s;
  return Buffer.from(s, 'utf8').subarray(0, limit).toString('utf8').replace(/�+$/, '');
}

/** A compactor reply as one line: no fences, no echoed `id+n|` head, newlines as spaces. */
export function cleanLine(raw: string): string {
  return flat(raw).trim().replace(/^```[a-z]*\s*|\s*```$/g, '').replace(/^\d+(\+\d+)?\|/, '').trim();
}

/** Enforce the node size in the harness: cut at the last "; " or sentence end (else comma) past half the limit. */
export function cutLine(raw: string, limit = NODE): { line: string; cut: boolean } {
  let line = cleanLine(raw);
  if (bytes(line) <= limit) return { line, cut: false };
  const prefix = cutBytes(line, limit);
  let at = prefix.length;
  for (const tier of [['; ', '. ', '! ', '? ', '。', '；', '！', '？'], [', ', '，', '、']]) {
    let best = -1;
    for (const sep of tier) best = Math.max(best, prefix.lastIndexOf(sep));
    if (best >= 0 && bytes(prefix.slice(0, best)) > limit / 2) { at = best + (/[;,，、；]/.test(prefix.charAt(best)) ? 0 : 1); break; }
  }
  line = prefix.slice(0, at).trim().replace(/[;,，、；]+$/, '');
  return { line, cut: true };
}

export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDate(value: Date | number | string): string {
  const d = new Date(value), pad = (n: number): string => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ?? '';
  return `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone} (${weekday})`;
}
