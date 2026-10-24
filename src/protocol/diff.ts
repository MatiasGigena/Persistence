// The server's side of feed sync: what changed between the items a peer was sent and the current ones, as item ops
// (messages.ts ItemOp), and the clipping that keeps a huge tool output off the wire. Shared by Node and the browser.
import { wireImage } from './images.ts';
import { LIMITS } from './messages.ts';
import type { AppendField, ChatImage, ChatItem, ItemOp } from './messages.ts';

/** Room kept for the marker `clip` puts between the head and the tail. */
const MARK_ROOM = 64;
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * `text` if it is at most `max` code units, else its head and tail with `\n… [N characters clipped] …\n` between,
 * at most `max` in all. A surrogate pair is never split.
 */
export function clip(text: string, max: number = LIMITS.clip): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - MARK_ROOM);
  let head = Math.floor(keep / 2), tail = text.length - (keep - head);
  if (head > 0 && isHigh(text.charCodeAt(head - 1))) head--;
  if (tail < text.length && isLow(text.charCodeAt(tail))) tail++;
  return `${text.slice(0, head)}\n… [${tail - head} characters clipped] …\n${text.slice(tail)}`;
}

/** Wire forms of image lists, so an unchanged list keeps one wire array and `change` sees no change. */
const wired = new WeakMap<readonly ChatImage[], readonly ChatImage[]>();

/** `images` as they go on the wire (images.ts `wireImage`): the same array when every image fits. */
function wireImages(images: readonly ChatImage[]): readonly ChatImage[] {
  const known = wired.get(images);
  if (known) return known;
  const each = images.map(wireImage);
  const out = each.every((image, k) => image === images[k]) ? images : each;
  wired.set(images, out);
  return out;
}

/**
 * The item as it goes on the wire: a tool's `output` and `args` clipped, and images too large for a frame sent
 * without their data. The same object when nothing changes.
 */
export function wireItem(item: ChatItem): ChatItem {
  if (item.kind === 'user') {
    const images = item.images && wireImages(item.images);
    return images === item.images ? item : { ...item, images };
  }
  if (item.kind !== 'tool') return item;
  const output = clip(item.output), args = clip(item.args);
  const images = item.images && wireImages(item.images);
  return output === item.output && args === item.args && images === item.images ? item
    : withImages({ ...item, output, args }, images);
}

const withImages = <T extends object>(item: T, images: readonly ChatImage[] | undefined): T =>
  images === undefined ? item : { ...item, images };

/** The ids of `items` in order, or undefined when an id repeats. */
function ids(items: readonly ChatItem[]): Map<string, ChatItem> | undefined {
  const byId = new Map<string, ChatItem>();
  for (const item of items) {
    if (byId.has(item.id)) return undefined;
    byId.set(item.id, item);
  }
  return byId;
}

const APPENDABLE: ReadonlySet<string> = new Set<AppendField>(['text', 'output', 'args']);
const isAppendField = (key: string): key is AppendField => APPENDABLE.has(key);

/** The ops that turn `a` into `b` (same id): none, appends when only text fields grew, else one put. */
function change(a: ChatItem, b: ChatItem): ItemOp[] {
  if (a === b) return [];
  // Every ChatItem field is a primitive or an `images` list that is never mutated, so a shallow look sees everything.
  const x: Readonly<Record<string, unknown>> = a, y: Readonly<Record<string, unknown>> = b;
  const keys = Object.keys(y);
  if (keys.length !== Object.keys(x).length) return [{ op: 'put', item: b }];
  const appends: ItemOp[] = [];
  for (const key of keys) {
    const before = x[key], after = y[key];
    if (before === after) continue;
    if (!isAppendField(key) || typeof before !== 'string' || typeof after !== 'string' || !after.startsWith(before)) {
      return [{ op: 'put', item: b }];
    }
    appends.push({ op: 'append', id: b.id, field: key, at: before.length, text: after.slice(before.length) });
  }
  return appends;
}

/**
 * The ops that turn `prev` (what the peer has) into `next`, or 'snapshot' when ops cannot say it:
 * - an id repeats in either list;
 * - the items in both lists are not in the same relative order (the order rule).
 * Ops come as: every `del` first, then `put` and `append` in `next`'s order. A new item is put before the next
 * item that both lists hold, or at the end when none follows; an item whose text fields only grew gets `append`s,
 * any other change a `put`. Unchanged items produce nothing; equal lists give []. Clip with `wireItem` first.
 */
export function diffItems(prev: readonly ChatItem[], next: readonly ChatItem[]): ItemOp[] | 'snapshot' {
  const before = ids(prev), after = ids(next);
  if (!before || !after) return 'snapshot';
  const kept = prev.filter(item => after.has(item.id));
  const order = next.filter(item => before.has(item.id));
  if (kept.some((item, k) => item.id !== order[k]?.id)) return 'snapshot';
  const ops: ItemOp[] = prev.filter(item => !after.has(item.id)).map(item => ({ op: 'del', id: item.id }));
  // For each position, the id of the next item both lists hold.
  const anchors: (string | undefined)[] = [];
  let anchor: string | undefined;
  for (let i = next.length - 1; i >= 0; i--) {
    anchors[i] = anchor;
    const item = next[i];
    if (item && before.has(item.id)) anchor = item.id;
  }
  next.forEach((item, i) => {
    const old = before.get(item.id);
    if (old) { ops.push(...change(old, item)); return; }
    const at = anchors[i];
    ops.push(at === undefined ? { op: 'put', item } : { op: 'put', item, before: at });
  });
  return ops;
}
