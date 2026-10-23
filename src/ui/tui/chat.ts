// Renders a ChatFeed: one block per item, kept by item id, so an update re-renders only that block.
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { ChatFeed, ChatItem } from '../types.ts';
import { NARROW } from './theme.ts';
import type { Theme } from './theme.ts';

export type NoticeLevel = Extract<ChatItem, { kind: 'notice' }>['level'];

/** Tool output lines shown while collapsed. */
export const TOOL_PREVIEW = 4;
/** Tool output lines shown while collapsed, below NARROW columns. */
export const TOOL_PREVIEW_NARROW = 2;
/** Chat items shown from the feed's history when the view opens. */
export const BACKLOG = 6;

/** What every block reads at render time. */
interface ViewState {
  readonly theme: Theme;
  toolsExpanded: boolean;
  thinkingExpanded: boolean;
}

// Plain text from models and tools must not move the cursor: keep newlines, expand tabs, drop escape
// sequences (CSI first, so their parameters go too) and other control characters.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clean = (text: string): string => text.replace(/\t/g, '  ').replace(CONTROL, '');
const oneLine = (text: string): string => clean(text).replace(/\s+/g, ' ').trim();

const PROMPT_START = '\x1b]133;A\x07';
const PROMPT_END = '\x1b]133;B\x07\x1b]133;C\x07';

const wrap = (text: string, width: number): string[] => wrapTextWithAnsi(text, Math.max(1, width));
/** `mark` (one column) and a space, then `lines` indented under it. */
const gutter = (mark: string, lines: readonly string[]): string[] => lines.map((line, i) => `${i ? ' ' : mark} ${line}`);

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
 * One meaningful argument of a tool call, on one line: bash its command, read/write/edit the path, zoom `id+n`
 * or the agent name, agent tools the agent's name; any other tool its arguments as compact JSON, truncated.
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

const sameItem = (a: ChatItem, b: ChatItem): boolean => {
  if (a === b) return true;
  const x: Record<string, unknown> = a;
  const y: Record<string, unknown> = b;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(key => x[key] === y[key]);
};

/** One chat item. It caches its lines until the item, the width, or an expansion flag changes. */
class ItemBlock implements Component {
  item: ChatItem;
  private readonly state: ViewState;
  private markdown: Markdown | undefined;
  private markdownPadding = 2;
  private cache: { width: number; key: string; lines: string[] } | undefined;

  constructor(item: ChatItem, state: ViewState) {
    this.item = item;
    this.state = state;
  }

  /** Takes the item's new value; false when nothing changed. */
  update(item: ChatItem): boolean {
    if (sameItem(this.item, item)) return false;
    this.item = item;
    this.cache = undefined;
    return true;
  }

  invalidate(): void {
    this.cache = undefined;
    this.markdown?.invalidate();
  }

  render(width: number): string[] {
    const { toolsExpanded, thinkingExpanded } = this.state;
    const key = `${String(toolsExpanded)}${String(thinkingExpanded)}`;
    if (this.cache?.width === width && this.cache.key === key) return this.cache.lines;
    const lines = this.build(width).map(line => truncateToWidth(line, width));
    // OSC 133 prompt zones, as Pi marks them: ctrl+up and ctrl+down jump between your messages.
    if (this.item.kind === 'user' && lines.length) {
      lines[0] = `${PROMPT_START}${lines[0] ?? ''}`;
      lines[lines.length - 1] = `${PROMPT_END}${lines.at(-1) ?? ''}`;
    }
    this.cache = { width, key, lines };
    return lines;
  }

  private build(width: number): string[] {
    const { theme } = this.state;
    const item = this.item;
    switch (item.kind) {
      case 'user':
        return gutter(theme.accent('❯'), wrap(clean(item.text).trimEnd(), width - 2));
      case 'assistant': {
        const text = item.text.trim();
        if (!text) return [];
        // Markdown keeps its padding, so a narrow screen gets a new one without it.
        const padding = width < NARROW ? 0 : 2;
        if (this.markdown && this.markdownPadding === padding) this.markdown.setText(text);
        else this.markdown = new Markdown(text, padding, 0, theme.markdown);
        this.markdownPadding = padding;
        return this.markdown.render(width);
      }
      case 'thinking':
        return this.thinking(item.text, width);
      case 'tool':
        return this.tool(item, width);
      case 'report':
        return wrap(theme.agent(`${theme.bold(`[${oneLine(item.from)}]`)} ${clean(item.text).trim()}`), width - 2)
          .map((line, i) => i ? `  ${line}` : line);
      case 'notice': {
        const style = item.level === 'error' ? theme.error : item.level === 'warn' ? theme.warning : theme.dim;
        const mark = item.level === 'info' ? '·' : '!';
        return gutter(style(mark), wrap(style(clean(item.text).trim()), width - 2));
      }
    }
  }

  private thinking(text: string, width: number): string[] {
    const { theme, thinkingExpanded } = this.state;
    const lines = clean(text).split('\n').map(line => line.trim()).filter(Boolean);
    const first = lines[0];
    if (first === undefined) return [];
    const style = (s: string): string => theme.dim(theme.italic(s));
    if (thinkingExpanded) return gutter(style('∴'), wrap(style(lines.join('\n')), width - 2));
    const hidden = lines.length - 1;
    const more = hidden > 0 ? theme.dim(width < NARROW ? ` +${hidden} ^t` : ` (+${hidden} lines, ctrl+t)`) : '';
    return [`${style('∴')} ${truncateToWidth(style(first), Math.max(1, width - 2 - visibleWidth(more)))}${more}`];
  }

  private tool(item: Extract<ChatItem, { kind: 'tool' }>, width: number): string[] {
    const { theme, toolsExpanded } = this.state;
    const narrow = width < NARROW, indent = narrow ? ' ' : '  ';
    const mark = item.status === 'running' ? theme.dim('…') : item.status === 'done' ? theme.success('✓') : theme.error('✗');
    const head = `${mark} ${theme.bold(oneLine(item.name))}`;
    const room = width - visibleWidth(head) - 1;
    const summary = toolSummary(item.name, item.args);
    const header = `${head}${room > 1 && summary ? ` ${theme.dim(truncateToWidth(summary, room, '…'))}` : ''}`;
    const output = clean(item.output).replace(/\s+$/, '');
    if (!output) return [header];
    const style = item.status === 'error' ? theme.error : theme.dim;
    const lines = output.split('\n');
    const inner = Math.max(1, width - indent.length);
    if (toolsExpanded) return [header, ...lines.flatMap(line => wrap(style(line), inner)).map(line => `${indent}${line}`)];
    const shown = lines.slice(0, narrow ? TOOL_PREVIEW_NARROW : TOOL_PREVIEW)
      .map(line => `${indent}${truncateToWidth(style(line), inner)}`);
    const hidden = lines.length - shown.length;
    const more = narrow ? `+${hidden} lines ^o` : `… ${hidden} more lines, ctrl+o to expand`;
    return [header, ...shown, ...hidden > 0 ? [`${indent}${theme.dim(more)}`] : []];
  }
}

export interface ChatViewOptions {
  /** Items of the feed's history to show when the view opens (default BACKLOG); later items always show. */
  readonly backlog?: number;
}

/**
 * A ChatFeed as a component. `sync()` reads the feed: new ids get a block, changed items update theirs,
 * and unchanged blocks keep their cached lines. Local notices (`notice()`) sit after the item that was last
 * when they were added. Reusable for any feed, Pi's or an agent's.
 */
export class ChatView implements Component {
  private readonly feed: ChatFeed;
  private readonly state: ViewState;
  private readonly backlog: number;
  private readonly blocks = new Map<string, ItemBlock>();
  /** Local notices by the id of the item they follow; undefined: before every item. */
  private readonly notices = new Map<string | undefined, ItemBlock[]>();
  private hidden: ReadonlySet<string> | undefined;
  private order: ItemBlock[] = [];
  private noticeCount = 0;

  constructor(feed: ChatFeed, theme: Theme, options: ChatViewOptions = {}) {
    this.feed = feed;
    this.state = { theme, toolsExpanded: false, thinkingExpanded: false };
    this.backlog = Math.max(0, options.backlog ?? BACKLOG);
    this.sync();
  }

  get toolsExpanded(): boolean { return this.state.toolsExpanded; }
  set toolsExpanded(expanded: boolean) { this.state.toolsExpanded = expanded; }
  get thinkingExpanded(): boolean { return this.state.thinkingExpanded; }
  set thinkingExpanded(expanded: boolean) { this.state.thinkingExpanded = expanded; }

  /** Reads the feed again. */
  sync(): void {
    const items = this.feed.items();
    this.hidden ??= new Set(items.slice(0, Math.max(0, items.length - this.backlog)).map(item => item.id));
    const live = new Set<string>();
    const order = [...this.notices.get(undefined) ?? []];
    for (const item of items) {
      live.add(item.id);
      if (!this.hidden.has(item.id)) {
        let block = this.blocks.get(item.id);
        if (block?.item.kind === item.kind) block.update(item);
        else this.blocks.set(item.id, block = new ItemBlock(item, this.state));
        order.push(block);
      }
      order.push(...this.notices.get(item.id) ?? []);
    }
    for (const id of this.blocks.keys()) if (!live.has(id)) this.blocks.delete(id);
    // A notice whose item left the feed moves to the end rather than vanishing.
    for (const [after, blocks] of this.notices) if (after !== undefined && !live.has(after)) order.push(...blocks);
    this.order = order;
  }

  /** Shows host text in the chat, after the current last item. */
  notice(text: string, level: NoticeLevel = 'info'): void {
    const after = this.feed.items().at(-1)?.id;
    const block = new ItemBlock({ kind: 'notice', id: `tui:${++this.noticeCount}`, text, level }, this.state);
    this.notices.set(after, [...this.notices.get(after) ?? [], block]);
    this.order.push(block);
  }

  invalidate(): void {
    for (const block of this.order) block.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    let previous: ChatItem['kind'] | undefined;
    for (const block of this.order) {
      const rendered = block.render(width);
      if (!rendered.length) continue;
      // Consecutive tool calls stay together; every other block gets a blank line above it.
      if (previous !== undefined && !(previous === 'tool' && block.item.kind === 'tool')) lines.push('');
      lines.push(...rendered);
      previous = block.item.kind;
    }
    return lines;
  }
}
