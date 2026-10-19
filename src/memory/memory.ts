import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { leafTask, mergeTask, PLACEHOLDER, PROMPT, tooLong } from './prompt.ts';
import { createPiAiSummarizer, defaultCompactionModel } from './summarizer.ts';
import {
  appendJson, atomicWrite, bytes, CAP, cleanLine, clip, cutLine, flat, formatDate, hash, localDay, NODE, split,
} from './util.ts';
import { cut, end, key, name, parentOf, start, View } from './view.ts';

export const KINDS = new Set(['user', 'pi', 'tool', 'echo', 'work', 'note']);
export const VIEW = { hi: 128_000, lo: 64_000 };
export const COMPACTION_VIEW = { hi: 32_000, lo: 16_000 };
export const JOBS = 8;      // compactions in flight at once
export const LEAD = 8;      // a leaf starts once fewer than this many leaves before it are unbuilt
export const PAGE = 16_000; // characters per zoom(id, 1) page

const opened = new Set();
const PLACEHOLDER_LINE = p => `${name(p)}|${PLACEHOLDER}`;

class Heap {
  constructor(before) { this.before = before; this.items = []; }
  get size() { return this.items.length; }
  push(x) {
    const a = this.items;
    let i = a.push(x) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.before(a[i], a[up])) break;
      [a[i], a[up]] = [a[up], a[i]];
      i = up;
    }
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function readJsonl(dir, warn) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, n) => {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch { warn(`unii: skipped damaged line ${file}:${n + 1}`); }
    });
  }
  return out;
}

/**
 * One chat's memory (recipe §1-§4): the log, the tree, the view, and the compactor that builds the tree in the
 * background. One process owns a directory (see openMemory).
 */
export class Memory {
  constructor(dir, {
    summarize, models, model, compactionModel, reasoning, maxTokens, tooLongRetries = 1,
    jobs = JOBS, lead = LEAD, retryMs = 10_000, view = VIEW, compactionView = COMPACTION_VIEW,
    warn = message => console.error(message),
  } = {}) {
    this.dir = dir;
    this.warn = warn;
    this.jobs = jobs;
    this.lead = lead;
    this.retryMs = retryMs;
    this.tooLongRetries = tooLongRetries;
    this.summarize = summarize ?? (models
      ? createPiAiSummarizer({ models, model: compactionModel ?? defaultCompactionModel(model, models), reasoning, maxTokens })
      : async () => { throw new Error('unii: no summarizer configured (pass summarize or models)'); });
    this.log = [];
    this.bySrc = new Map();
    this.tree = new Map();
    this.sizes = new Map();
    this.listeners = new Set();
    this.inFlight = new Map();
    this.failed = new Map();
    this.controller = new AbortController();
    this.compactionPrompt = undefined;
    this.lastError = undefined;
    this.closing = false;
    this.closed = false;
    const sizeOf = p => this.lineSize(p), built = p => this.tree.has(key(p));
    this.view = new View({ ...view, sizeOf, built });
    this.cview = new View({ ...compactionView, sizeOf, built });
    for (const sub of ['main', 'tree']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    this.load();
    this.schedule();
  }

  // ---------------------------------------------------------------- load and save

  load() {
    const records = readJsonl(join(this.dir, 'main'), this.warn)
      .filter(r => Number.isSafeInteger(r?.i) && typeof r.text === 'string' && KINDS.has(r.kind))
      .sort((a, b) => a.i - b.i);
    records.forEach((r, n) => {
      if (r.i !== n) throw new Error(`unii: log in ${this.dir} is not contiguous at ${n} (found ${r.i}); refusing to open`);
      this.log.push(r);
      if (r.src) this.bySrc.set(r.src, r.i);
    });
    const T = this.log.length;
    for (const n of readJsonl(join(this.dir, 'tree'), this.warn)) {
      if (!Number.isSafeInteger(n?.l) || !Number.isSafeInteger(n?.i) || typeof n.text !== 'string' || end(n) > T) continue;
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
    this.merges = new Heap((a, b) => start(a) < start(b) || (start(a) === start(b) && a.l < b.l));
    for (const n of this.tree.values()) this.readyParent(n);
  }

  loadViews(T) {
    const file = join(this.dir, 'view.json');
    if (!existsSync(file)) return false;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const pairs = [saved.view, saved.cview];
      [this.view, this.cview].forEach((v, n) => {
        v.parts = pairs[n].map(([l, i]) => ({ l, i }));
        v.shrinking = Boolean(saved.shrinking?.[n]);
        const at = v.parts.length ? end(v.parts.at(-1)) : 0;
        if (!v.tiles(at) || at > T || v.parts.some(p => p.l > 0 && !this.tree.has(key(p)))) throw new Error('does not tile the log');
      });
      // The log may be ahead of view.json after a crash: add the missing lines as they would have come.
      for (let i = end(this.view.parts.at(-1) ?? { l: 0, i: -1 }); i < T; i++) this.grow(i);
      return this.cview.tiles(T);
    } catch (error) {
      this.warn(`unii: view.json unreadable (${error.message}); folding the log again`);
      return false;
    }
  }

  save() {
    atomicWrite(join(this.dir, 'view.json'), JSON.stringify({
      view: this.view.parts.map(p => [p.l, p.i]),
      cview: this.cview.parts.map(p => [p.l, p.i]),
      shrinking: [this.view.shrinking, this.cview.shrinking],
    }));
  }

  /** Message i joins both views; a chat-view batch resets the compaction view from it (recipe §4). */
  grow(i) {
    this.view.append(i);
    this.cview.append(i);
    this.refit(i + 1);
  }

  refit(T = this.log.length) {
    if (this.view.fit(T)) {
      this.cview.parts = this.view.parts.map(p => ({ ...p }));
      this.cview.shrinking = this.cview.bytes > this.cview.lo;
    }
    this.cview.fit(T);
  }

  // ---------------------------------------------------------------- the log

  /**
   * Append one message to the log (recipe §1). Only appends; each line is fsynced before this returns.
   *
   * - `kind`: 'user' | 'pi' | 'tool' | 'echo' | 'work' | 'note'. A `work` text must start with "[Name]".
   * - `text`: the message. Tool output (`echo`) is clipped to its head and tail, 30,000 characters in all; any other
   *   text longer than that is logged as several messages in a row. Empty text logs nothing.
   * - `date`: when it happened (Date, ms or ISO string; default now).
   * - `src`: optional idempotency key. A second append with a logged `src` logs nothing, also after a restart.
   *
   * Returns the records written: `{ i, kind, text, size, date, src? }`.
   */
  append({ kind, text, date = new Date(), src } = {}) {
    if (this.closing) throw new Error('unii: memory is closed');
    if (!KINDS.has(kind)) throw new Error(`unii: unknown kind ${kind}`);
    if (typeof text !== 'string') throw new Error('unii: text must be a string');
    if (kind === 'work' && !/^\[[^\]\n]+\]/.test(text)) throw new Error('unii: a work message starts with "[Name]"');
    if ((src !== undefined && this.bySrc.has(src)) || !text.trim()) return [];
    const iso = new Date(date).toISOString();
    const file = join(this.dir, 'main', `${localDay(new Date())}.jsonl`);
    const written = (kind === 'echo' ? [clip(text)] : split(text, CAP)).map((part, n) => {
      const record = { i: this.log.length, kind, text: part, size: bytes(`${kind}: ${part}`), date: iso };
      if (src !== undefined) record.src = n === 0 ? src : `${src}#${n}`;
      appendJson(file, record);
      this.log.push(record);
      if (record.src) this.bySrc.set(record.src, record.i);
      this.grow(record.i);
      return record;
    });
    this.save();
    this.retryFailed(); // a failed call is tried again at the next message
    this.schedule();
    this.emit();
    return written;
  }

  /**
   * Log a subagent's report as a `work` message "[name] text". Plug into the agents extension's `onReport`.
   * `id` keys it (pass the same `id` as `data.id` of the report's input entry so neither path logs it twice);
   * without one, the same name and text are logged once.
   */
  report({ name: agent, text, id, date }) {
    const body = text.startsWith(`[${agent}]`) ? text : `[${agent}] ${text}`;
    return this.append({ kind: 'work', text: body, date, src: reportSrc({ name: agent, text, id }) });
  }

  has(src) { return this.bySrc.has(src); }
  get T() { return this.log.length; }

  // ---------------------------------------------------------------- reads

  text(p) { return this.tree.get(key(p))?.text; }
  renderLine(p) { const text = this.text(p); return text === undefined ? PLACEHOLDER_LINE(p) : `${name(p)}|${flat(text)}`; }
  lineSize(p) {
    const k = key(p);
    if (!this.tree.has(k)) return bytes(PLACEHOLDER_LINE(p)) + 1;
    let size = this.sizes.get(k);
    if (size === undefined) this.sizes.set(k, size = bytes(this.renderLine(p)) + 1);
    return size;
  }

  /** The view of messages [0, k) in <chat> tags; k defaults to now. Also the first message of a subagent. */
  render(k = this.log.length) {
    const parts = k >= this.log.length ? this.view.parts : cut(this.view.parts, k);
    return `<chat>\n${parts.map(p => `${this.renderLine(p)}\n`).join('')}</chat>`;
  }

  /** Whether every view line before message k is summarized. */
  ready(k = this.log.length) {
    return (k >= this.log.length ? this.view.parts : cut(this.view.parts, k)).every(p => this.tree.has(key(p)));
  }

  /** Wait until ready(k), at most timeoutMs; resolves whether it got there. */
  settle(timeoutMs, signal, k) {
    if (this.ready(k)) return Promise.resolve(true);
    return new Promise(done => {
      const finish = ok => { off(); clearTimeout(timer); signal?.removeEventListener('abort', abort); done(ok); };
      const off = this.onChange(() => { if (this.ready(k) || this.closed) finish(this.ready(k)); });
      const timer = setTimeout(() => finish(false), timeoutMs);
      const abort = () => finish(false);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** zoom(id, n): line id+n opened into its two halves; n = 1 gives message id whole, in pages of PAGE characters. */
  zoom(id, n = 1, page = 1) {
    const T = this.log.length;
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > T) {
      throw new Error(`No line ${id}+${n}: n is a power of 2, id a multiple of n, and id+n at most ${T}.`);
    }
    if (n === 1) {
      const record = this.log[id], whole = `${record.kind}: ${record.text}`;
      const pages = Math.max(1, Math.ceil(whole.length / PAGE));
      if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error(`Message ${id} has ${pages} page(s).`);
      const body = whole.slice((page - 1) * PAGE, page * PAGE);
      return pages === 1 ? `${id}+1|${body}` : `${id}+1 (page ${page} of ${pages}; zoom(${id}, 1, page) for the others)|${body}`;
    }
    const l = Math.log2(n) - 1, i = (2 * id) / n;
    return [i, i + 1].map(c => {
      const p = { l, i: c };
      return this.tree.has(key(p)) ? this.renderLine(p) : `${name(p)}|(not summarized yet: zoom(${start(p)}, ${2 ** l}))`;
    }).join('\n');
  }

  date(id) {
    const record = this.log[id];
    if (!Number.isSafeInteger(id) || !record) throw new Error(`No message ${id}.`);
    return formatDate(record.date);
  }

  /**
   * The exchange right before message k, whole: the last user (or work) message and the reply that ends just before k,
   * in at most `limit` bytes; '' when there is none or it is longer (pi-endless deviation #3).
   */
  previousExchange(k = this.log.length, limit = 16_000) {
    let j = Math.min(k, this.log.length);
    const previous = () => { // the message ending before j, its split parts joined
      let first = j - 1;
      while (first > 0 && /#\d+$/.test(this.log[first].src ?? '')) first--;
      const parts = this.log.slice(first, j);
      j = first;
      return { kind: parts[0].kind, text: parts.map(r => r.text).join(''), bytes: parts.reduce((n, r) => n + r.size, 0) };
    };
    if (j === 0 || this.log[j - 1].kind !== 'pi') return '';
    const reply = previous(), asked = [];
    let size = reply.bytes;
    while (j > 0 && size <= limit) {
      const m = previous();
      if (m.kind === 'user' || m.kind === 'work') { asked.unshift(m); size += m.bytes; }
      else if (asked.length) break;
      if (asked.length && !['user', 'work'].includes(this.log[j - 1]?.kind)) break;
    }
    if (!asked.length) return '';
    const text = `<previous_exchange>\n${[...asked, reply].map(m => `${m.kind}: ${m.text}`).join('\n\n')}\n</previous_exchange>`;
    return bytes(text) <= limit ? text : '';
  }

  // ---------------------------------------------------------------- events

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(); } catch (error) { this.warn(`unii: listener failed: ${error.message}`); } } }

  /** Status: messages, unbuilt leaves, calls in flight, failed nodes, last error. */
  status() {
    let built = 0;
    for (let i = 0; i < this.log.length; i++) if (this.tree.has(`0/${i}`)) built++;
    return { messages: this.log.length, unsummarized: this.log.length - built, active: this.inFlight.size,
      failed: this.failed.size, lastError: this.lastError, viewBytes: this.view.bytes, viewLines: this.view.parts.length };
  }

  // ---------------------------------------------------------------- the compactor (recipe §4)

  /** The prompt and tools of the latest turn, so compactions share the turns' prefix (set by the extension). */
  setCompactionPrompt(prompt) { this.compactionPrompt = prompt; }

  schedule() {
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  leafSource(i) { const r = this.log[i]; return `${r.kind}: ${r.text}`; }
  joined(p) { return `${this.text({ l: p.l - 1, i: 2 * p.i })}\n${this.text({ l: p.l - 1, i: 2 * p.i + 1 })}`; }
  busy(p) { const k = key(p); return this.tree.has(k) || this.inFlight.has(k) || this.failed.has(k); }

  /** Node n is built: queue its parent once its sibling is built too. */
  readyParent(n) {
    if (!this.tree.has(key({ l: n.l, i: n.i ^ 1 }))) return;
    const p = parentOf(n);
    if (this.busy(p)) return;
    if (bytes(this.joined(p)) <= NODE) this.instant.push(p);
    else this.merges.push(p);
  }

  pump() {
    if (this.closing) return;
    let changed = false;
    for (let progressed = true; progressed;) {
      progressed = false;
      while (this.instant.length) {
        const p = this.instant.pop();
        if (!this.tree.has(key(p))) { this.finish(p, this.joined(p)); progressed = changed = true; }
      }
      while (this.retryLeaves.length && this.inFlight.size < this.jobs) {
        const p = this.retryLeaves.shift();
        if (!this.busy(p)) this.call(p);
      }
      while (this.leafNext < this.log.length && this.leafOpen < this.lead) {
        const p = { l: 0, i: this.leafNext };
        if (this.tree.has(key(p))) { this.leafNext++; continue; }
        const source = this.leafSource(p.i), free = bytes(source) <= NODE;
        if (!free && this.inFlight.size >= this.jobs) break;
        this.leafNext++;
        this.leafOpen++;
        if (free) { this.finish(p, source); progressed = changed = true; } else this.call(p);
      }
      while (this.merges.size && this.inFlight.size < this.jobs) {
        const p = this.merges.pop();
        if (!this.busy(p)) this.call(p);
      }
    }
    if (changed) { this.save(); this.emit(); }
  }

  finish(p, text) {
    const k = key(p);
    if (this.tree.has(k)) return;
    const node = { l: p.l, i: p.i, text, size: bytes(flat(text)) };
    appendJson(join(this.dir, 'tree', `${localDay(new Date())}.jsonl`), node);
    this.tree.set(k, node);
    this.failed.delete(k);
    if (p.l === 0 && p.i < this.leafNext) this.leafOpen--;
    this.readyParent(node);
    this.refit();
  }

  call(p) {
    const k = key(p);
    const run = this.compact(p).then(line => {
      if (this.controller.signal.aborted) return;
      this.finish(p, line);
      if (!this.failed.size) this.lastError = undefined;
      this.save();
    }).catch(error => {
      if (this.controller.signal.aborted) return;
      this.lastError = error?.message ?? String(error);
      this.warn(`unii: compaction ${name(p)} failed: ${this.lastError}`);
      this.failed.set(k, p);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { this.retryFailed(); this.schedule(); }, this.retryMs);
      this.retryTimer.unref?.();
    }).finally(() => {
      this.inFlight.delete(k);
      this.emit();
      this.schedule();
    });
    this.inFlight.set(k, run);
  }

  retryFailed() {
    for (const p of this.failed.values()) {
      if (p.l === 0) this.retryLeaves.push(p);
      else this.merges.push(p);
    }
    this.retryLeaves.sort((a, b) => a.i - b.i);
    this.failed.clear();
  }

  /** The compaction view up to node p: built lines ending at p (a leaf) or at its last message (a merge). */
  compactionContext(p) {
    const boundary = p.l === 0 ? start(p) : end(p), lines = [];
    for (const q of this.cview.parts) {
      if (end(q) > boundary || !this.tree.has(key(q))) break;
      lines.push(`${this.renderLine(q)}\n`);
    }
    return `<chat>\n${lines.join('')}</chat>`;
  }

  /** One node by the model: task with the ruler, then the harness enforces the size (pi-endless deviation #1). */
  async compact(p) {
    let task;
    if (p.l === 0) {
      const r = this.log[p.i];
      task = leafTask(p.i, r.kind, r.text);
    } else {
      const a = { l: p.l - 1, i: 2 * p.i }, b = { l: p.l - 1, i: 2 * p.i + 1 };
      task = mergeTask(name(a), name(b), start(p), end(p) - 1, this.renderLine(a), this.renderLine(b));
    }
    const { system = PROMPT, tools } = this.compactionPrompt ?? {};
    const messages = [{ role: 'user', content: `${this.compactionContext(p)}\n\n${task}` }];
    const ask = () => this.summarize(system, messages, { signal: this.controller.signal, tools, node: { l: p.l, i: p.i, name: name(p) } });
    let raw = cleanLine(String(await ask() ?? ''));
    if (!raw) throw new Error('the compactor returned no text');
    let best = raw;
    for (let n = 0; n < this.tooLongRetries && bytes(best) > NODE; n++) {
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: tooLong(raw) });
      try { raw = cleanLine(String(await ask() ?? '')); } catch (error) {
        if (this.controller.signal.aborted) throw error;
        break; // keep the shortest line so far; the cut below fits it
      }
      if (raw && bytes(raw) < bytes(best)) best = raw;
    }
    return cutLine(best).line;
  }

  /** Stop taking work, give calls in flight up to graceMs (they are redone at the next open otherwise), save. */
  async close(graceMs = 5_000) {
    if (this.closed) return;
    this.closing = true;
    clearTimeout(this.retryTimer);
    if (this.inFlight.size) {
      let timer;
      await Promise.race([Promise.allSettled(this.inFlight.values()), new Promise(r => { timer = setTimeout(r, graceMs); })]);
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

export const reportSrc = ({ name: agent, text, id }) => `report:${id ?? hash(`${agent}\n${text}`)}`;

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
export function openMemory(dir, options) {
  const at = resolve(dir);
  if (opened.has(at)) throw new Error(`unii: memory ${at} is already open in this process`);
  opened.add(at);
  try { return new Memory(at, options); } catch (error) { opened.delete(at); throw error; }
}
