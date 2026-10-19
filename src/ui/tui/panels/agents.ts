// /agents: the agent list, live from the session's status, and each agent's chat as a read-only feed.
import { Markdown, styleTextWithAnsi, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import type { AgentInfo } from '../../../agents/index.ts';
import type { ChatFeed, ChatItem, UiSession } from '../../types.ts';
import { toolSummary } from '../chat.ts';
import { clean, ListView, openPanel, PanelFrame, TextView, wrap } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';

export type { PanelTheme } from './frame.ts';

/** Opens the agents panel over the chat; resolves when it closes and the editor has focus again. */
export function openAgentsPanel(tui: TUI, session: UiSession, theme: PanelTheme): Promise<void> {
  const list = new ListView({
    title: 'Agents', theme, root: true,
    rows: () => agentRows(session.status().agents, theme),
    empty: () => 'No agents yet. Ask Pi to spawn one.',
    onOpen: row => { void openChat(row.key); },
    dispose: session.onStatus(() => tui.requestRender()),
  });
  const frame = new PanelFrame(tui, theme, list);

  async function openChat(name: string): Promise<void> {
    let feed: ChatFeed | undefined, failure = `No agent named ${name}.`;
    try { feed = await session.agentChat(name); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (frame.isClosed || frame.top() !== list) { void feed?.close().catch(() => undefined); return; }
    if (!feed) { frame.push(new TextView({ title: name, lines: () => [theme.error(failure)] })); return; }
    const chat = feed, renderer = new ChatRenderer(theme), unsubscribe = chat.subscribe(() => tui.requestRender());
    frame.push(new TextView({
      title: name, follow: true,
      lines: width => renderer.render(chat.items(), width),
      dispose: () => { unsubscribe(); void chat.close().catch(() => undefined); },
    }));
  }

  return openPanel(tui, frame);
}

/** One row per agent: a dot (filled while busy), the name, role, parent and state, in columns; compact rows drop the parent. */
export function agentRows(agents: readonly AgentInfo[], theme: PanelTheme): Row[] {
  const width = (f: (a: AgentInfo) => string): number => Math.max(0, ...agents.map(a => f(a).length));
  const nameW = width(a => a.name), parentW = width(a => a.parent);
  return agents.map(a => {
    const name = clean(a.name).padEnd(nameW), role = a.role.padEnd(4), parent = `parent ${clean(a.parent).padEnd(parentW)}`;
    const dot = a.busy ? '●' : '○', state = a.busy ? 'busy' : 'idle';
    const tint = a.busy ? theme.accent : theme.dim;
    return {
      key: a.name,
      plain: `${dot} ${name}  ${role}  ${parent}  ${state}`,
      styled: `${tint(dot)} ${name}  ${theme.dim(role)}  ${theme.dim(parent)}  ${tint(state)}`,
      compact: { plain: `${dot} ${name}  ${role}  ${state}`, styled: `${tint(dot)} ${name}  ${theme.dim(role)}  ${tint(state)}` },
    };
  });
}

/**
 * A compact, read-only chat renderer: Markdown for assistant text, one line per tool call, and
 * plain blocks for the rest. The shell's chat.ts renders the main chat; merge the two later.
 */
export class ChatRenderer {
  private readonly theme: PanelTheme;
  private readonly markdown: MarkdownTheme;
  // Items are immutable and replaced on change, so an item's lines stay valid for its width.
  private readonly cache = new WeakMap<ChatItem, { width: number; lines: string[] }>();

  constructor(theme: PanelTheme) {
    this.theme = theme;
    this.markdown = markdownTheme(theme);
  }

  render(items: readonly ChatItem[], width: number): string[] {
    if (items.length === 0) return [this.theme.dim('Nothing here yet.')];
    return items.flatMap((item, i) => {
      let hit = this.cache.get(item);
      if (hit?.width !== width) this.cache.set(item, hit = { width, lines: this.item(item, width) });
      return i === 0 ? hit.lines : ['', ...hit.lines];
    });
  }

  private item(item: ChatItem, width: number): string[] {
    const { accent, dim, error } = this.theme;
    switch (item.kind) {
      case 'user': return wrap(item.text, width - 2).map((l, i) => `${i === 0 ? accent('›') : ' '} ${l}`);
      case 'assistant': return new Markdown(item.text, 0, 0, this.markdown).render(width);
      case 'thinking': return wrap(item.text, width).map(l => dim(italic(l)));
      case 'tool': {
        const mark = item.status === 'running' ? dim('…') : item.status === 'error' ? error('✗') : dim('✓');
        return [`${mark} ${truncateToWidth(`${accent(clean(item.name))} ${dim(toolSummary(item.name, item.args))}`, width - 2, '…')}`];
      }
      case 'report': return wrapTextWithAnsi(`${accent(`[${clean(item.from)}]`)} ${clean(item.text)}`, width);
      case 'notice': {
        const tint = item.level === 'error' ? error : item.level === 'warn' ? accent : dim;
        return wrap(item.text, width).map(l => tint(l));
      }
    }
  }
}

const italic = (text: string): string => styleTextWithAnsi(text, undefined, undefined, { italic: true });

function markdownTheme({ accent, dim, bold }: PanelTheme): MarkdownTheme {
  const plain = (text: string): string => text;
  const attr = (a: 'italic' | 'strikethrough' | 'underline') => (text: string): string => styleTextWithAnsi(text, undefined, undefined, { [a]: true });
  return {
    heading: t => bold(accent(t)), link: accent, linkUrl: dim, code: accent, codeBlock: plain, codeBlockBorder: dim,
    quote: dim, quoteBorder: dim, hr: dim, listBullet: accent, bold, italic: attr('italic'),
    strikethrough: attr('strikethrough'), underline: attr('underline'),
  };
}
