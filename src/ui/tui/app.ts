// The terminal chat: a scrolling chat, a one-line footer, and the editor, in Pi's default full-screen
// (alternate screen) layout. On exit the chat is printed to the main screen, so it stays in scrollback.
import {
  CombinedAutocompleteProvider, Container, Editor, matchesKey, ProcessTerminal, ScrollView, truncateToWidth,
  TuiAltScreen, VStack,
} from '@earendil-works/pi-tui';
import type { Component, SlashCommand, Terminal, TUI } from '@earendil-works/pi-tui';
import type { SessionStatus, UiSession } from '../types.ts';
import { ChatView } from './chat.ts';
import type { NoticeLevel } from './chat.ts';
import { Footer } from './footer.ts';
import { openAgentsPanel } from './panels/agents.ts';
import { openMemoryPanel } from './panels/memory.ts';
import { theme } from './theme.ts';

/** Shows host text (a warning, a runtime report) as a notice in the chat. */
export type ShowNotice = (text: string, level?: NoticeLevel) => void;

export interface TuiInfo {
  /** Base directory of Tab path completion. */
  readonly cwd: string;
  /** The host's shutdown: when it aborts, the TUI restores the terminal and `runTui` resolves. */
  readonly signal?: AbortSignal;
  /** Chat items of the history shown at startup (default chat.ts BACKLOG). */
  readonly backlog?: number;
  /** Default: the process's terminal. */
  readonly terminal?: Terminal;
  /** Called once the TUI is up, with the way to show host text while it runs. */
  readonly onStart?: (show: ShowNotice) => void;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: 'help', description: 'Commands and keys' },
  { name: 'agents', description: 'Agents and their conversations' },
  { name: 'mem', description: "Pi's memory view" },
  { name: 'status', description: 'Model, work, memory and agents' },
  { name: 'exit', description: 'Close; unfinished work resumes next launch' },
];

const HELP = [
  '/agents  agents and their chats     /mem  the memory view, zoomable',
  '/status  model, work, memory        /exit  close (ctrl+d on an empty editor)',
  'enter send · shift+enter or alt+enter newline · ↑↓ history · esc interrupt Pi',
  'ctrl+o tool output · ctrl+t thinking · ctrl+c clear, twice quit · pgup/pgdn scroll',
  'Unfinished work and agents resume on the next launch.',
].join('\n');

/** Two Ctrl+C presses within this many ms exit. */
const DOUBLE_CTRL_C = 1000;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A compact status block, for /status. */
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

/** One line computed at render time. */
class Line implements Component {
  private readonly text: () => string;
  constructor(text: () => string) { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] { return [truncateToWidth(this.text(), width)]; }
}

/** The editor with the app's keys in front of it; `onKey` returns true when it handled the key. */
class ChatEditor extends Editor {
  onKey: ((data: string) => boolean) | undefined;
  override handleInput(data: string): void {
    if (!this.onKey?.(data)) super.handleInput(data);
  }
}

/**
 * Run the chat in the terminal until the user exits (/exit, Ctrl+D, Ctrl+C twice) or `info.signal` aborts.
 * The terminal is restored on every path, including a process exit while it runs.
 */
export async function runTui(session: UiSession, info: TuiInfo): Promise<void> {
  if (info.signal?.aborted) return;
  const terminal = info.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const chat = new ChatView(session.chat, theme, info.backlog === undefined ? {} : { backlog: info.backlog });
  const footer = new Footer(() => session.status(), theme);
  const editor = new ChatEditor(tui, theme.editor, { paddingX: 1 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...COMMANDS], info.cwd));
  const header = new Line(() => {
    const { model, toolsEnabled } = session.status();
    return `${theme.bold(theme.accent('Pi'))}${theme.dim(` · ${model} · tools ${toolsEnabled ? 'on' : 'off'}`)}`;
  });
  const document = new Container();
  document.addChild(header);
  document.addChild(chat);
  const layout = new VStack([
    { component: new ScrollView(document, { follow: 'end', primary: true, overscroll: 'chain' }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: footer, basis: 'auto', shrink: 0 },
    { component: editor, basis: 'auto', shrink: 1, minSize: 3 },
  ]);

  let running = true;
  let lastCtrlC = 0;
  let spinner: NodeJS.Timeout | undefined;
  const render = (): void => { if (running) tui.requestRender(); };
  const show: ShowNotice = (text, level = 'info') => { chat.notice(text, level); render(); };
  const spin = (): void => {
    const busy = session.status().busy;
    if (busy && !spinner) spinner = setInterval(() => { footer.tick(); render(); }, 80).unref();
    if (!busy && spinner) { clearInterval(spinner); spinner = undefined; }
  };

  const { promise: closed, resolve } = Promise.withResolvers<void>();
  const unsubscribes = [
    session.chat.subscribe(() => { chat.sync(); render(); }),
    session.onStatus(() => { spin(); render(); }),
  ];
  /** Restores the terminal once. Synchronous, so it can run in a process 'exit' listener. */
  const restore = (): void => {
    if (!running) return;
    running = false;
    clearInterval(spinner);
    for (const unsubscribe of unsubscribes) unsubscribe();
    info.signal?.removeEventListener('abort', onAbort);
    process.off('exit', restore);
    for (let i = 0; i < 32 && tui.hasOverlay(); i++) tui.hideOverlay();
    // Leave the chat, without the footer and editor, in the main screen's scrollback.
    tui.setLayoutRoot(document);
    tui.stop();
    resolve();
  };
  const exit = async (): Promise<void> => {
    if (!running) return;
    // Late key releases (Kitty protocol) would otherwise reach the shell.
    await terminal.drainInput(500).catch(() => undefined);
    restore();
  };
  function onAbort(): void { restore(); }

  const panel = (open: (tui: TUI, session: UiSession, panelTheme: typeof theme) => Promise<void>): void => {
    // Not awaited: the panel takes focus from the editor and hands it back when it closes.
    open(tui, session, theme).catch((error: unknown) => show(`Panel failed: ${message(error)}`, 'error'));
  };
  const command = (line: string): void => {
    const name = line.slice(1).split(/\s/, 1)[0] ?? '';
    if (name === 'help') show(HELP);
    else if (name === 'status') show(statusText(session.status()));
    else if (name === 'agents') panel(openAgentsPanel);
    else if (name === 'mem') panel(openMemoryPanel);
    else if (name === 'exit' || name === 'quit') void exit();
    else show(`Unknown command ${line.split(/\s/, 1)[0] ?? line}. /help lists them.`, 'warn');
  };

  editor.onSubmit = text => {
    const line = text.trim();
    if (!line) return;
    editor.addToHistory(line);
    if (line.startsWith('/')) command(line);
    else session.send(line).catch((error: unknown) => show(`Not sent: ${message(error)}`, 'error'));
  };
  editor.onKey = data => {
    if (matchesKey(data, 'escape')) {
      if (editor.isShowingAutocomplete()) return false;
      session.abort().catch((error: unknown) => show(`Interrupt failed: ${message(error)}`, 'error'));
    } else if (matchesKey(data, 'ctrl+c')) {
      const now = Date.now();
      if (now - lastCtrlC < DOUBLE_CTRL_C) void exit();
      else editor.setText('');
      lastCtrlC = now;
    } else if (matchesKey(data, 'ctrl+d')) {
      if (editor.getText()) return false;
      void exit();
    } else if (matchesKey(data, 'ctrl+o')) {
      chat.toolsExpanded = !chat.toolsExpanded;
    } else if (matchesKey(data, 'ctrl+t')) {
      chat.thinkingExpanded = !chat.thinkingExpanded;
    } else return false;
    render();
    return true;
  };

  info.signal?.addEventListener('abort', onAbort, { once: true });
  process.on('exit', restore);
  try {
    tui.setLayoutRoot(layout);
    tui.setFocus(editor);
    tui.start();
    spin();
    info.onStart?.(show);
  } catch (error) {
    restore();
    throw error;
  }
  return closed;
}
