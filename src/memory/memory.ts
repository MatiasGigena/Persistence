import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { leafTask, mergeTask, PLACEHOLDER, PROMPT, tooLong } from './prompt.ts';
import { CompactionRefused, createPiAiSummarizer, defaultCompactionModel } from './summarizer.ts';
import type { CompactionMessage, Reasoning, Summarizer, SummarizerModels } from './summarizer.ts';
import { bytes, CAP, cleanLine, clip, cutBytes, cutLine, flat, formatDate, hash, localDay, NODE, split } from './util.ts';
import { appendJson, atomicWrite } from '../runtime/files.ts';
import { errorMessage, isRecord } from '../protocol/util.ts';
import { cut, end, key, name, parentOf, start, View } from './view.ts';
import type { Pos } from './view.ts';

const KIND_LIST = ['user', 'pi', 'tool', 'echo', 'work', 'note'] as const;
/** A message's kind (recipe §1); persisted in the log, never renamed. */
export type Kind = typeof KIND_LIST[number];
export const KINDS: ReadonlySet<string> = new Set(KIND_LIST);
export const isKind = (x: unknown): x is Kind => typeof x === 'string' && KINDS.has(x);

/** One logged message, as a line of main/YYYY-MM-DD.jsonl. `src` of a split text's later parts ends in `#n`. */
export type MemoryRecord = { i: number; kind: Kind; text: string; size: number; date: string; src?: string };
/** One built tree node, as a line of tree/YYYY-MM-DD.jsonl (`size` is computed at load, not trusted from disk). */
export type TreeNode = Pos & { text: string; size: number };
/** View budgets in bytes: past `hi` a batch merges down to at most `lo`. */
export type Budget = { hi: number; lo: number };
export type AppendInput = { kind: Kind; text: string; date?: Date | number | string; src?: string };
/**
 * A subagent's report; `id` (the delivery task's ID) keys it. `session` (from 1) is the standing agent's session it came
 * from, so its link opens that one (`zoom("Name#n")`) even after a later delegate.
 */
export type ReportInput = {
  name: string; text: string; id?: string | number | undefined; date?: Date | number | string; session?: number | undefined;
};
/** The prompt and tools of the latest turn, so compactions share the turns' cached prefix. */
export type CompactionPrompt = { system?: string; tools?: readonly Tool[] };
export type MemoryStatus = {
  messages: number; unsummarized: number; active: number; failed: number; lastError: string | undefined;
  viewBytes: number; viewLines: number;
};
export type MemoryOptions = {
  summarize?: Summarizer;
  models?: SummarizerModels;
  model?: ModelRef;
  compactionModel?: ModelRef;
  reasoning?: Reasoning;
  maxTokens?: number;
  tooLongRetries?: number;
  jobs?: number;
  lead?: number;
  retryMs?: number;
  view?: Budget;
  compactionView?: Budget;
  warn?: (message: string) => void;
};

export const VIEW: Budget = { hi: 128_000, lo: 64_000 };
export const COMPACTION_VIEW: Budget = { hi: 32_000, lo: 16_000 };
export const JOBS = 8;      // compactions in flight at once
export const LEAD = 8;      // a leaf starts once fewer than this many leaves before it are unbuilt
export const PAGE = CAP;    // characters per zoom(id, 1) page: a logged text is one page

const opened = new Set<string>();
const PLACEHOLDER_LINE = (p: Pos): string => `${name(p)}|${PLACEHOLDER}`;
// Work goes in the order the messages came: a node by the end of its context (a leaf's message, a merge's end), a merge
// before a leaf at a tie (UniiChat Memory.ts `starts`).
const mergeOrder = (a: Pos, b: Pos): boolean => end(a) < end(b) || (end(a) === end(b) && a.l > b.l);

class Heap<T> {
  before: (a: T, b: T) => boolean;
  items: T[] = [];
  constructor(before: (a: T, b: T) => boolean) { this.before = before; }
  get size(): number { return this.items.length; }
  peek(): T | undefined { return this.items[0]; }
  push(x: T): void {
    const a = this.items;
    let i = a.push(x) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1, above = a[up];
      if (above === undefined || !this.before(x, above)) break;
      a[i] = above;
      i = up;
    }
    a[i] = x;
  }
  pop(): T | undefined {
    const a = this.items, top = a[0], last = a.pop();
    if (a.length && last !== undefined) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1, left = a[l], right = a[r];
        let m = i, best = last;
        if (left !== undefined && this.before(left, best)) { m = l; best = left; }
        if (right !== undefined && this.before(right, best)) { m = r; best = right; }
        if (m === i) break;
        a[i] = best;
        i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

function readJsonl(dir: string, warn: (message: string) => void): unknown[] {
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, n) => {
      if (!line.trim()) return;
      try { const value: unknown = JSON.parse(line); out.push(value); } catch { warn(`unii: skipped damaged line ${file}:${n + 1}`); }
    });
  }
  return out;
}

const isMemoryRecord = (r: unknown): r is MemoryRecord => isRecord(r) && Number.isSafeInteger(r.i) && typeof r.text === 'string'
  && isKind(r.kind) && typeof r.size === 'number' && typeof r.date === 'string' && (r.src === undefined || typeof r.src === 'string');
const isNode = (n: unknown): n is Pos & { text: string } => isRecord(n) && Number.isSafeInteger(n.l) && Number.isSafeInteger(n.i)
  && typeof n.text === 'string';
/** view.json's `[l, i]` pairs. */
function pairs(x: unknown): Pos[] {
  if (!Array.isArray(x)) throw new Error('no line list');
  const list: unknown[] = x;
  return list.map(pair => {
    if (!Array.isArray(pair)) throw new Error('a line is not [l, i]');
    const tuple: unknown[] = pair, [l, i] = tuple;
    if (typeof l !== 'number' || typeof i !== 'number') throw new Error('a line is not [l, i]');
    return { l, i };
  });
}

/**
 * One chat's memory (recipe §1-§4): the log, the tree, the view, and the compactor that builds the tree in the
 * background. One process owns a directory (see openMemory).
 */
export class Memory {
  dir: string;
  warn: (message: string) => void;
  jobs: number;
  lead: number;
  retryMs: number;
  tooLongRetries: number;
  summarize: Summarizer;
  log: MemoryRecord[] = [];
  bySrc = new Map<string, number>();
  tree = new Map<string, TreeNode>();
  sizes = new Map<string, number>();
  listeners = new Set<() => void>();
  inFlight = new Map<string, Promise<void>>();
  failed = new Map<string, Pos>();
  controller = new AbortController();
  compactionPrompt: CompactionPrompt | undefined = undefined;
  lastError: string | undefined = undefined;
  closing = false;
  closed = false;
  scheduled = false;
  retryTimer: NodeJS.Timeout | undefined = undefined;
  view: View;
  cview: View;
  leafNext = 0;
  leafOpen = 0;
  retryLeaves: Pos[] = [];
  instant: Pos[] = [];
  merges = new Heap<Pos>(mergeOrder);

  constructor(dir: string, {
    summarize, models, model, compactionModel, reasoning, maxTokens, tooLongRetries = 1,
    jobs = JOBS, lead = LEAD, retryMs = 10_000, view = VIEW, compactionView = COMPACTION_VIEW,
    warn = message => console.error(message),
  }: MemoryOptions = {}) {
    this.dir = dir;
    this.warn = warn;
    this.jobs = jobs;
    this.lead = lead;
    this.retryMs = retryMs;
    this.tooLongRetries = tooLongRetries;
    this.summarize = summarize ?? (models
      ? createPiAiSummarizer({ models, model: compactionModel ?? defaultCompactionModel(model, models), reasoning, maxTokens })
      : async () => { throw new Error('unii: no summarizer configured (pass summarize or models)'); });
    const sizeOf = (p: Pos): number => this.lineSize(p), built = (p: Pos): boolean => this.tree.has(key(p));
    this.view = new View({ ...view, sizeOf, built });
    this.cview = new View({ ...compactionView, sizeOf, built });
    for (const sub of ['main', 'tree']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    this.load();
    this.schedule();
  }

  // ---------------------------------------------------------------- load and save

  load(): void {
    const records = readJsonl(join(this.dir, 'main'), this.warn).filter(isMemoryRecord).sort((a, b) => a.i - b.i);
    records.forEach((r, n) => {
      if (r.i !== n) throw new Error(`unii: log in ${this.dir} is not contiguous at ${n} (found ${r.i}); refusing to open`);
      this.log.push(r);
      if (r.src) this.bySrc.set(r.src, r.i);
    });
    const T = this.log.length;
    for (const n of readJsonl(join(this.dir, 'tree'), this.warn)) {
      if (!isNode(n) || end(n) > T) continue;
      this.tree.set(key(n), { l: n.l, i: n.i, text: n.text, size: bytes(flat(n.text)) });
    }
    if (!this.loadViews(T)) {
      // First open (or an unreadable view.json): fold the log once. From then on the view is saved and never rebuilt.
      for (const v of [this.view, this.cview]) { v.parts = []; v.shrinking = false; }
      for (let i = 0; i < T; i++) this.grow(i);
    }
    this.save();
    // Ready queues from the tree, once: merges whose halves are built, leaves from the first unbuilt one on.
    this.leafNext = 0;
    this.leafOpen = 0;
    this.retryLeaves = [];
    this.instant = [];
    this.merges = new Heap(mergeOrder);
    for (const n of this.tree.values()) this.readyParent(n);
  }

  loadViews(T: number): boolean {
    const file = join(this.dir, 'view.json');
    if (!existsSync(file)) return false;
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(saved)) throw new Error('not an object');
      const lists = [saved.view, saved.cview], shrinking = saved.shrinking;
      [this.view, this.cview].forEach((v, n) => {
        v.parts = pairs(lists[n]).flatMap(p => this.down(p));
        v.shrinking = Array.isArray(shrinking) && Boolean(shrinking[n]);
        const last = v.parts.at(-1), at = last ? end(last) : 0;
        if (!v.tiles(at) || at > T) throw new Error('does not tile the log');
      });
      // The log may be ahead of view.json after a crash: add the missing lines as they would have come.
      for (let i = end(this.view.parts.at(-1) ?? { l: 0, i: -1 }); i < T; i++) this.grow(i);
      return this.cview.tiles(T);
    } catch (error) {
      this.warn(`unii: view.json unreadable (${errorMessage(error)}); folding the log again`);
      return false;
    }
  }

  /** A saved line whose node is missing (a tree line lost in a crash) opens into its halves, down to built nodes. */
  down(p: Pos): Pos[] {
    if (p.l <= 0 || this.tree.has(key(p))) return [p];
    return [{ l: p.l - 1, i: 2 * p.i }, { l: p.l - 1, i: 2 * p.i + 1 }].flatMap(c => this.down(c));
  }

  save(): void {
    atomicWrite(join(this.dir, 'view.json'), JSON.stringify({
      view: this.view.parts.map(p => [p.l, p.i]),
      cview: this.cview.parts.map(p => [p.l, p.i]),
      shrinking: [this.view.shrinking, this.cview.shrinking],
    }));
  }

  /** Message i joins both views. */
  grow(i: number): void {
    this.view.append(i);
    this.cview.append(i);
    this.refit(i + 1, true);
  }

  /** Both views run their own sawtooth (UniiChat Memory.ts `fit`); between messages only whole batches land. */
  refit(T = this.log.length, atMessage = false): void {
    this.view.fit(T, atMessage);
    this.cview.fit(T, atMessage);
  }

  // ---------------------------------------------------------------- the log

  /**
   * Append one message to the log (recipe §1). Only appends; each line is fsynced before this returns.
   *
   * - `kind`: 'user' | 'pi' | 'tool' | 'echo' | 'work' | 'note'. A `work` text must start with "[Name]".
   * - `text`: the message, made well-formed (no lone surrogates). Tool output (`echo`) is clipped to its head and tail,
   *   30,000 characters in all; any other text longer than that is logged as several messages in a row, in one write.
   *   Empty text logs nothing.
   * - `date`: when it happened (Date, ms or ISO string; default now).
   * - `src`: optional idempotency key. A second append with a logged `src` logs nothing, also after a restart.
   *
   * Returns the records written: `{ i, kind, text, size, date, src? }`.
   */
  append({ kind, text, date = new Date(), src }: AppendInput): MemoryRecord[] {
    if (this.closing) throw new Error('unii: memory is closed');
    if (!isKind(kind)) throw new Error(`unii: unknown kind ${String(kind)}`);
    if (typeof text !== 'string') throw new Error('unii: text must be a string');
    if (kind === 'work' && !/^\[[^\]\n]+\]/.test(text)) throw new Error('unii: a work message starts with "[Name]"');
    if ((src !== undefined && this.bySrc.has(src)) || !text.trim()) return [];
    const iso = new Date(date).toISOString();
    const file = join(this.dir, 'main', `${localDay(new Date())}.jsonl`);
    const whole = text.toWellFormed();
    const written = (kind === 'echo' ? [clip(whole)] : split(whole, CAP)).map((part, n) => {
      const record: MemoryRecord = { i: this.log.length + n, kind, text: part, size: bytes(`${kind}: ${part}`), date: iso };
      if (src !== undefined) record.src = n === 0 ? src : `${src}#${n}`;
      return record;
    });
    appendJson(file, ...written); // all parts or none: a crash between parts would lose the rest (src is logged)
    for (const record of written) {
      this.log.push(record);
      if (record.src) this.bySrc.set(record.src, record.i);
      this.grow(record.i);
    }
    this.save();
    this.retryFailed(); // a failed call is tried again at the next message
    this.schedule();
    this.emit();
    return written;
  }

  /**
   * Log a subagent's report as a `work` message as Pi sees it (upstream Call.ts `report_text`, Apache-2.0):
   * `[Name]\ntext\n\nFull chat: zoom("Name")`, or `zoom("Name#n")` with a `session`. Plug into the agents extension's `onReport`.
   * `id` keys it (pass the same `id` as `data.id` of the report's input entry so neither path logs it twice);
   * without one, the same name and text are logged once.
   */
  report({ name: agent, text, id, date, session }: ReportInput): MemoryRecord[] {
    const body = `[${agent}]\n${text}\n\nFull chat: zoom("${agent}${session === undefined ? '' : `#${session}`}")`;
    return this.append({ kind: 'work', text: body, date, src: reportSrc({ name: agent, text, id }) });
  }

  has(src: string): boolean { return this.bySrc.has(src); }
  get T(): number { return this.log.length; }

  /** Message i of the log; throws when there is none. */
  at(i: number): MemoryRecord {
    const record = this.log[i];
    if (!record) throw new Error(`No message ${i}.`);
    return record;
  }

  // ---------------------------------------------------------------- reads

  text(p: Pos): string | undefined { return this.tree.get(key(p))?.text; }
  renderLine(p: Pos): string { const text = this.text(p); return text === undefined ? PLACEHOLDER_LINE(p) : `${name(p)}|${flat(text)}`; }
  lineSize(p: Pos): number {
    const k = key(p);
    if (!this.tree.has(k)) return bytes(PLACEHOLDER_LINE(p)) + 1;
    let size = this.sizes.get(k);
    if (size === undefined) this.sizes.set(k, size = bytes(this.renderLine(p)) + 1);
    return size;
  }

  /** The view of messages [0, k) in <chat> tags; k defaults to now. Also the first message of a subagent. */
  render(k = this.log.length): string {
    const parts = k >= this.log.length ? this.view.parts : cut(this.view.parts, k);
    return `<chat>\n${parts.map(p => `${this.renderLine(p)}\n`).join('')}</chat>`;
  }

  /** Whether every view line before message k is summarized. */
  ready(k = this.log.length): boolean {
    return (k >= this.log.length ? this.view.parts : cut(this.view.parts, k)).every(p => this.tree.has(key(p)));
  }

  /**
   * Where a turn's new messages [from, T) go whole from (adapted from UniiChat Memory.ts `whole`, Apache-2.0): the
   * first id from which the messages to the end fit in `limit` bytes; the last message always goes whole. The ones
   * before it (a huge paste's first parts) belong in the view: render(k) and say(k, T).
   */
  whole(from: number, limit = this.view.hi): number {
    let k = this.log.length, size = 0;
    for (; k > from; k--) {
      size += this.at(k - 1).size;
      if (k < this.log.length && size > limit) return k;
    }
    return k;
  }

  /** Messages [a, b) as one text: a split text's parts rejoined, separate messages a blank line apart. */
  say(a: number, b = this.log.length): string {
    return this.log.slice(a, b).map((r, n) => (n > 0 && !/#\d+$/.test(r.src ?? '') ? '\n\n' : '') + r.text).join('');
  }

  /** Wait until ready(k), at most timeoutMs; resolves whether it got there. */
  settle(timeoutMs: number, signal?: AbortSignal, k?: number): Promise<boolean> {
    if (this.ready(k)) return Promise.resolve(true);
    return new Promise(done => {
      const finish = (ok: boolean): void => { off(); clearTimeout(timer); signal?.removeEventListener('abort', abort); done(ok); };
      const off = this.onChange(() => { if (this.ready(k) || this.closed) finish(this.ready(k)); });
      const timer = setTimeout(() => finish(false), timeoutMs);
      const abort = (): void => finish(false);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /**
   * zoom(id, n): line id+n opened into its two halves; n = 1 gives message id whole, a text over PAGE characters in
   * pages. Bad arguments throw with the tree's roots, where any zoom can start (UniiChat Memory.ts `zoom`).
   */
  zoom(id: number, n = 1, page = 1): string {
    const T = this.log.length;
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > T) {
      throw new Error(`No line ${id}+${n}: n is a power of 2, id a multiple of n, and id+n at most ${T}. The tree's roots: ${roots(T).map(name).join(', ') || 'none'}.`);
    }
    if (n === 1) {
      const record = this.at(id), pages = split(record.text, PAGE);
      const body = pages[page - 1];
      if (!Number.isSafeInteger(page) || body === undefined) throw new Error(`Message ${id} has ${pages.length} page(s).`);
      const head = pages.length === 1 ? `${id}+1` : `${id}+1 (page ${page} of ${pages.length}; zoom(${id}, 1, page) for the others)`;
      return `${head}|${record.kind}: ${body}`;
    }
    const l = Math.log2(n) - 1, i = (2 * id) / n;
    return [i, i + 1].map(c => {
      const p = { l, i: c };
      return this.tree.has(key(p)) ? this.renderLine(p) : `${name(p)}|(not summarized yet: zoom(${start(p)}, ${2 ** l}))`;
    }).join('\n');
  }

  date(id: number): string {
    const record = this.log[id];
    if (!Number.isSafeInteger(id) || !record) throw new Error(`No message ${id}.`);
    return formatDate(record.date);
  }

  /**
   * The exchange right before message k, whole: the last user (or work) message and the reply that ends just before k,
   * in at most `limit` bytes; '' when there is none or it is longer (deviation 3 in docs/memory.md).
   */
  previousExchange(k = this.log.length, limit = 16_000): string {
    let j = Math.min(k, this.log.length);
    const previous = (): { kind: Kind; text: string; bytes: number } => { // the message ending before j, its split parts joined
      let first = j - 1;
      while (first > 0 && /#\d+$/.test(this.at(first).src ?? '')) first--;
      const parts = this.log.slice(first, j);
      j = first;
      return { kind: this.at(first).kind, text: parts.map(r => r.text).join(''), bytes: parts.reduce((n, r) => n + r.size, 0) };
    };
    if (j === 0 || this.at(j - 1).kind !== 'pi') return '';
    const reply = previous(), asked: ReturnType<typeof previous>[] = [];
    let size = reply.bytes;
    while (j > 0 && size <= limit) {
      const m = previous();
      if (m.kind === 'user' || m.kind === 'work') { asked.unshift(m); size += m.bytes; }
      else if (asked.length) break;
      const before = this.log[j - 1]?.kind;
      if (asked.length && before !== 'user' && before !== 'work') break;
    }
    if (!asked.length) return '';
    const text = `<previous_exchange>\n${[...asked, reply].map(m => `${m.kind}: ${m.text}`).join('\n\n')}\n</previous_exchange>`;
    return bytes(text) <= limit ? text : '';
  }

  // ---------------------------------------------------------------- events

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(): void { for (const fn of this.listeners) { try { fn(); } catch (error) { this.warn(`unii: listener failed: ${errorMessage(error)}`); } } }

  /** Status: messages, unbuilt leaves, calls in flight, failed nodes, last error. */
  status(): MemoryStatus {
    let built = 0;
    for (let i = 0; i < this.log.length; i++) if (this.tree.has(`0/${i}`)) built++;
    return { messages: this.log.length, unsummarized: this.log.length - built, active: this.inFlight.size,
      failed: this.failed.size, lastError: this.lastError, viewBytes: this.view.bytes, viewLines: this.view.parts.length };
  }

  // ---------------------------------------------------------------- the compactor (recipe §4)

  /** The prompt and tools of the latest turn, so compactions share the turns' prefix (set by the extension). */
  setCompactionPrompt(prompt: CompactionPrompt): void { this.compactionPrompt = prompt; }

  /**
   * Compact with `summarize` from now on, at most `jobs` calls at once (e.g. after the turn model changed). Calls in
   * flight finish with the summarizer they started with; lowering `jobs` only delays new calls.
   */
  setSummarizer(summarize: Summarizer, jobs = this.jobs): void {
    this.summarize = summarize;
    this.jobs = jobs;
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  leafSource(i: number): string { const r = this.at(i); return `${r.kind}: ${r.text}`; }
  /** A merge's source: its halves, each flat, one per line (UniiChat Memory.ts `source`). */
  joined(p: Pos): string { return `${flat(this.text({ l: p.l - 1, i: 2 * p.i }) ?? '')}\n${flat(this.text({ l: p.l - 1, i: 2 * p.i + 1 }) ?? '')}`; }
  source(p: Pos): string { return p.l === 0 ? this.leafSource(p.i) : this.joined(p); }
  busy(p: Pos): boolean { const k = key(p); return this.tree.has(k) || this.inFlight.has(k) || this.failed.has(k); }

  /** Node n is built: queue its parent once its sibling is built too. */
  readyParent(n: Pos): void {
    if (!this.tree.has(key({ l: n.l, i: n.i ^ 1 }))) return;
    const p = parentOf(n);
    if (this.busy(p)) return;
    if (bytes(this.joined(p)) <= NODE) this.instant.push(p);
    else this.merges.push(p);
  }

  pump(): void {
    if (this.closing) return;
    let changed = false;
    for (let progressed = true; progressed;) {
      progressed = false;
      for (let p = this.instant.pop(); p; p = this.instant.pop()) {
        if (!this.tree.has(key(p))) { this.finish(p, this.joined(p)); progressed = changed = true; }
      }
      while (this.retryLeaves.length && this.inFlight.size < this.jobs) {
        const p = this.retryLeaves.shift();
        if (p && !this.busy(p)) this.call(p);
      }
      // Leaves and merges in the order the messages came; a leaf that fits takes no call, so it never waits for one.
      for (;;) {
        while (this.leafNext < this.log.length && this.tree.has(`0/${this.leafNext}`)) this.leafNext++;
        for (let top = this.merges.peek(); top && this.busy(top); top = this.merges.peek()) this.merges.pop();
        const merge = this.merges.peek(), leaf = this.leafNext < this.log.length && this.leafOpen < this.lead;
        const slot = this.inFlight.size < this.jobs;
        if (merge && slot && (!leaf || end(merge) <= this.leafNext)) { this.merges.pop(); this.call(merge); continue; }
        if (!leaf) break;
        const p = { l: 0, i: this.leafNext }, source = this.leafSource(p.i), free = bytes(source) <= NODE;
        if (!free && !slot) break;
        this.leafNext++;
        this.leafOpen++;
        if (free) { this.finish(p, source); progressed = changed = true; } else this.call(p);
      }
    }
    if (changed) { this.save(); this.emit(); }
  }

  finish(p: Pos, text: string): void {
    const k = key(p);
    if (this.tree.has(k)) return;
    const node: TreeNode = { l: p.l, i: p.i, text, size: bytes(flat(text)) };
    appendJson(join(this.dir, 'tree', `${localDay(new Date())}.jsonl`), node);
    this.tree.set(k, node);
    this.failed.delete(k);
    if (p.l === 0 && p.i < this.leafNext) this.leafOpen--;
    this.readyParent(node);
    this.refit(this.log.length, false);
  }

  call(p: Pos): void {
    const k = key(p);
    const run = this.compact(p).then(line => {
      if (this.controller.signal.aborted) return;
      this.finish(p, line);
      if (!this.failed.size) this.lastError = undefined;
      this.save();
    }).catch((error: unknown) => {
      if (this.controller.signal.aborted) return;
      this.lastError = errorMessage(error);
      this.warn(`unii: compaction ${name(p)} failed: ${this.lastError}`);
      this.failed.set(k, p);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { this.retryFailed(); this.schedule(); }, this.retryMs);
      this.retryTimer.unref();
    }).finally(() => {
      this.inFlight.delete(k);
      this.emit();
      this.schedule();
    });
    this.inFlight.set(k, run);
  }

  retryFailed(): void {
    for (const p of this.failed.values()) {
      if (p.l === 0) this.retryLeaves.push(p);
      else this.merges.push(p);
    }
    this.retryLeaves.sort((a, b) => a.i - b.i);
    this.failed.clear();
  }

  /** The compaction view up to node p: built lines ending at p (a leaf) or at its last message (a merge). */
  compactionContext(p: Pos): string {
    const boundary = p.l === 0 ? start(p) : end(p), lines: string[] = [];
    for (const q of this.cview.parts) {
      if (end(q) > boundary || !this.tree.has(key(q))) break;
      lines.push(`${this.renderLine(q)}\n`);
    }
    return `<chat>\n${lines.join('')}</chat>`;
  }

  /**
   * One node by the model: the compaction view and the task with the ruler. A line over 512 bytes is asked again,
   * `tooLongRetries` times, each a fresh call of the task plus a note on the last line (UniiChat Memory.ts `build`); the
   * shortest is kept and the harness cuts it to size. An answer with no line (a refusal) makes the node its source,
   * clipped; any other failure throws, and the node is tried again later.
   */
  async compact(p: Pos): Promise<string> {
    let task;
    const source = this.source(p);
    if (p.l === 0) {
      const r = this.at(p.i);
      task = leafTask(p.i, r.kind, r.text);
    } else {
      const [a = '', b = ''] = source.split('\n');
      task = mergeTask(name({ l: p.l - 1, i: 2 * p.i }), name({ l: p.l - 1, i: 2 * p.i + 1 }), start(p), end(p) - 1, a, b);
    }
    const { system = PROMPT, tools } = this.compactionPrompt ?? {};
    const prompt = `${this.compactionContext(p)}\n\n${task}`;
    // One node, one model: a summarizer swapped mid-call serves only the nodes started after it.
    const { summarize } = this;
    const ask = async (note?: string): Promise<string> => {
      const messages: CompactionMessage[] = [{ role: 'user', content: note ? `${prompt}\n\n${note}` : prompt }];
      return cleanLine(String(await summarize(system, messages, { signal: this.controller.signal, tools, node: { l: p.l, i: p.i, name: name(p) } }) ?? ''));
    };
    let raw;
    try { raw = await ask(); } catch (error) {
      if (!(error instanceof CompactionRefused) || this.controller.signal.aborted) throw error;
      return this.clipped(p, source, error.message);
    }
    if (!raw) return this.clipped(p, source, 'an empty line');
    let best = raw;
    for (let n = 0; n < this.tooLongRetries && bytes(raw) > NODE; n++) {
      try { raw = await ask(tooLong(raw)); } catch (error) {
        if (this.controller.signal.aborted) throw error;
        break; // keep the shortest line so far; the cut below fits it
      }
      if (!raw) break;
      if (bytes(raw) < bytes(best)) best = raw;
    }
    return cutLine(best).line;
  }

  /** A node the model answered without a line: its source's first 512 bytes, flat (UniiChat Memory.ts `cut`). */
  clipped(p: Pos, source: string, why: string): string {
    this.warn(`unii: compaction ${name(p)}: ${why}; its node is its source, clipped`);
    return cutBytes(flat(source), NODE);
  }

  /** Stop taking work, give calls in flight up to graceMs (they are redone at the next open otherwise), save. */
  async close(graceMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    clearTimeout(this.retryTimer);
    if (this.inFlight.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled(this.inFlight.values()), new Promise<void>(r => { timer = setTimeout(r, graceMs); })]);
      clearTimeout(timer);
    }
    this.controller.abort();
    await Promise.allSettled(this.inFlight.values());
    this.save();
    this.closed = true;
    opened.delete(this.dir);
    this.emit();
  }
}

/** The tree's roots over T messages: a node per power of two in T, largest first. */
export function roots(T: number): Pos[] {
  const out: Pos[] = [];
  for (let l = Math.floor(Math.log2(Math.max(T, 1))), at = 0; l >= 0; l--) {
    if (at + 2 ** l <= T) { out.push({ l, i: at / 2 ** l }); at += 2 ** l; }
  }
  return out;
}

export const reportSrc = ({ name: agent, text, id }: ReportInput): string => `report:${id ?? hash(`${agent}\n${text}`)}`;

/**
 * Open (or create) the memory in `dir`. One writer per directory: the host must hold a lock for it. pi-durable's host
 * takes a flock on `<database>.lock` for its whole life; keep this directory next to that database (one global chat,
 * one database, one memory dir) and that lock covers it. A second open in the same process throws.
 *
 * Options: `summarize(systemPrompt, messages, { signal, tools, node }) → Promise<string>` (the compaction model; messages
 * are `{ role: 'user' | 'assistant', content: string }`), or `models` (a pi-ai Models / ModelRuntime) with
 * `compactionModel` / `model` ({ provider, modelId }) for the default pi-ai summarizer; `reasoning`, `maxTokens`,
 * `tooLongRetries` (default 1), `jobs`, `retryMs`, `view` / `compactionView` budgets ({ hi, lo } bytes), `warn`.
 */
export function openMemory(dir: string, options?: MemoryOptions): Memory {
  const at = resolve(dir);
  if (opened.has(at)) throw new Error(`unii: memory ${at} is already open in this process`);
  opened.add(at);
  try { return new Memory(at, options); } catch (error) { opened.delete(at); throw error; }
}
