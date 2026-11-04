// /agents: the agent list, live from the session's status, and each agent's chat as a read-only feed. `a` archives
// the selected agent and `A` every ad-hoc one, after a confirmation (ADR 0034); the last row opens the archived
// agents, with their deletion time, where Enter restores one. Refusals (a standing agent) show in the header.
import { Markdown, styleTextWithAnsi, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import { ARCHIVE_TTL_MS } from '../../../protocol/messages.ts';
import type { AgentStatus, ChatFeed, ChatItem, UiSession } from '../../types.ts';
import { activeAgents, adhocAgents, archiveAdhocQuestion, archivedAgents, archivedText, archiveQuestion, deletionText, toolSummary } from '../../text.ts';
import { clean, confirm, ListView, openPanel, PanelFrame, TextView, wrap } from './frame.ts';
import type { PanelTheme, Row } from './frame.ts';
import { errorMessage } from '../../../protocol/util.ts';

export type { PanelTheme } from './frame.ts';

/** The root list's last row, into the archived agents; no agent name starts with a space. */
const ARCHIVED_KEY = ' archived';
/** Deletion times are redrawn this often while the panel is open. */
const CLOCK_MS = 60_000;

/** Opens the agents panel over the chat; resolves when it closes and the editor has focus again. */
export function openAgentsPanel(tui: TUI, session: UiSession, theme: PanelTheme, now: () => number = Date.now): Promise<void> {
  /** The header's last outcome: what was archived or restored, or why not. */
  let said: { readonly text: string; readonly error: boolean } | undefined;
  let asking = false;
  const say = (text: string, error = false): void => { said = { text, error }; tui.requestRender(); };
  const clock = setInterval(() => tui.requestRender(), CLOCK_MS);
  clock.unref();
  const unsubscribe = session.onStatus(() => tui.requestRender());

  const list = new ListView({
    title: 'Agents', theme, root: true,
    rows: () => {
      const all = session.status().agents, archived = archivedAgents(all).length;
      const rows = agentRows(activeAgents(all), theme);
      if (archived) {
        const text = `  Archived (${archived}) ›`;
        rows.push({ key: ARCHIVED_KEY, plain: text, styled: theme.dim(text) });
      }
      return rows;
    },
    empty: () => 'No agents yet. Ask Pi to spawn one.',
    onOpen: row => { if (row.key === ARCHIVED_KEY) frame.push(archivedList()); else void openChat(row.key); },
    keys: (key, row) => {
      if (key === 'a' && row && row.key !== ARCHIVED_KEY) { void archiveOne(row.key); return true; }
      if (key === 'A') { void archiveAdhoc(); return true; }
      return false;
    },
    keyHint: narrow => (activeAgents(session.status().agents).length ? (narrow ? 'a archive' : 'a archive · A archive ad-hoc') : ''),
    dispose: () => { unsubscribe(); clearInterval(clock); },
  });
  const frame = new PanelFrame(tui, theme, list, () => {
    if (said) return said.error ? theme.error(clean(said.text)) : theme.accent(clean(said.text));
    const all = session.status().agents, active = activeAgents(all), archived = all.length - active.length;
    const busy = active.filter(a => a.busy).length;
    return theme.dim(`${active.length} agents · ${busy} busy${archived ? ` · ${archived} archived` : ''}`);
  });

  function archivedList(): ListView {
    return new ListView({
      title: 'Archived', theme, verb: 'restore',
      rows: () => archivedRows(archivedAgents(session.status().agents), now(), theme),
      empty: () => 'No archived agents.',
      onOpen: row => { void restore(row.key); },
    });
  }

  /** Asks `question` once at a time; false when the panel closed meanwhile. */
  async function ask(question: string): Promise<boolean> {
    if (asking) return false;
    asking = true;
    try { return await confirm(tui, theme, question) && !frame.isClosed; } finally { asking = false; }
  }

  async function archiveOne(name: string): Promise<void> {
    const subs = activeAgents(session.status().agents).filter(a => a.role === 'sub' && a.parent === name).map(a => a.name);
    if (!await ask(archiveQuestion(name, subs))) return;
    try { say(archivedText(await session.archiveAgents({ name }))); } catch (error) { say(errorMessage(error), true); }
  }

  async function archiveAdhoc(): Promise<void> {
    const names = adhocAgents(session.status().agents).map(a => a.name);
    if (!names.length) { say('No ad-hoc agents to archive.'); return; }
    if (!await ask(archiveAdhocQuestion(names))) return;
    try { say(archivedText(await session.archiveAgents({ adhoc: true }))); } catch (error) { say(errorMessage(error), true); }
  }

  async function restore(name: string): Promise<void> {
    try { say(archivedText(await session.restoreAgent(name), true)); } catch (error) { say(errorMessage(error), true); }
  }

  async function openChat(name: string): Promise<void> {
    let feed: ChatFeed | undefined, failed = `No agent named ${name}.`;
    try { feed = await session.agentChat(name); } catch (error) { failed = errorMessage(error); }
    if (frame.isClosed || frame.top() !== list) { void feed?.close().catch(() => undefined); return; }
    if (!feed) { frame.push(new TextView({ title: name, lines: () => [theme.error(failed)] })); return; }
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
export function agentRows(agents: readonly AgentStatus[], theme: PanelTheme): Row[] {
  const width = (f: (a: AgentStatus) => string): number => Math.max(0, ...agents.map(a => f(a).length));
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

/** One row per archived agent: the name, role, parent and when it is deleted; compact rows drop the parent. */
export function archivedRows(agents: readonly (AgentStatus & { readonly archivedAt: number })[], now: number, theme: PanelTheme): Row[] {
  const width = (f: (a: AgentStatus) => string): number => Math.max(0, ...agents.map(a => f(a).length));
  const nameW = width(a => a.name), parentW = width(a => a.parent);
  return agents.map(a => {
    const name = clean(a.name).padEnd(nameW), role = a.role.padEnd(4), parent = `parent ${clean(a.parent).padEnd(parentW)}`;
    const when = deletionText(a.archivedAt, now);
    return {
      key: a.name,
      plain: `− ${name}  ${role}  ${parent}  ${when}`,
      styled: `${theme.dim('−')} ${name}  ${theme.dim(role)}  ${theme.dim(parent)}  ${theme.accent(when)}`,
      compact: { plain: `− ${name}  ${when}`, styled: `${theme.dim('−')} ${name}  ${theme.accent(when)}` },
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

  /** The items with a blank line between them; items with nothing to show (only whitespace) take no space. */
  render(items: readonly ChatItem[], width: number): string[] {
    const lines: string[] = [];
    for (const item of items) {
      let hit = this.cache.get(item);
      if (hit?.width !== width) this.cache.set(item, hit = { width, lines: this.item(item, width) });
      if (!hit.lines.length) continue;
      if (lines.length) lines.push('');
      lines.push(...hit.lines);
    }
    return lines.length ? lines : [this.theme.dim('Nothing here yet.')];
  }

  private item(item: ChatItem, width: number): string[] {
    const { accent, dim, error } = this.theme;
    switch (item.kind) {
      case 'user': return wrap(item.text, width - 2).map((l, i) => `${i === 0 ? accent('›') : ' '} ${l}`);
      case 'assistant': return item.text.trim() ? new Markdown(item.text.trim(), 0, 0, this.markdown).render(width) : [];
      case 'thinking': return item.text.trim() ? wrap(item.text.trim(), width).map(l => dim(italic(l))) : [];
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
