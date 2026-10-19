// The terminal chat: a scrolling chat, a one-line footer, and the editor, in Pi's default full-screen
// (alternate screen) layout. On exit the chat is printed to the main screen, so it stays in scrollback.
import {
  CombinedAutocompleteProvider, Container, CURSOR_MARKER, Editor, matchesKey, ProcessTerminal, ScrollView, truncateToWidth,
  TuiAltScreen, VStack,
} from '@earendil-works/pi-tui';
import type { AutocompleteItem, Component, SlashCommand, Terminal, TUI } from '@earendil-works/pi-tui';
import type { SessionStatus, UiSession } from '../types.ts';
import { ChatView } from './chat.ts';
import type { NoticeLevel } from './chat.ts';
import { Footer, spinnerInterval } from './footer.ts';
import { openAgentsPanel } from './panels/agents.ts';
import { confirm } from './panels/frame.ts';
import { openMemoryPanel } from './panels/memory.ts';
import { modelRef, openModelPanel } from './panels/model.ts';
import { NARROW, theme } from './theme.ts';

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
  /** Read for SSH_CONNECTION, which slows the spinner. Default: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: 'help', description: 'Commands and keys' },
  { name: 'model', description: 'Pick a model (ctrl+l), or set provider/id', argumentHint: '[provider/id]' },
  { name: 'tools', description: 'Coding tools for this launch: on or off', argumentHint: '[on|off]' },
  { name: 'agents', description: 'Agents and their conversations' },
  { name: 'mem', description: "Pi's memory view" },
  { name: 'status', description: 'Model, work, memory and agents' },
  { name: 'stop', description: 'Interrupt Pi, as Esc does; /stop all or /stop Name stops agents' },
  { name: 'exit', description: 'Close; unfinished work resumes next launch' },
];

type HelpPair = readonly [name: string, description: string];

const HELP_COMMANDS: readonly HelpPair[] = [
  ['/model', 'pick a model (ctrl+l)'], ['/tools', 'coding tools: on, off'],
  ['/agents', 'agents and their chats'], ['/mem', 'the memory view'],
  ['/status', 'model, work, memory'], ['/stop', 'stop Pi (esc) · all · Name'],
  ['/exit', 'close (ctrl+d when empty)'],
];
const HELP_KEYS: readonly HelpPair[] = [
  ['enter', 'send'], ['alt+enter', 'newline (shift+enter)'],
  ['esc', 'interrupt Pi (/stop)'], ['↑↓', 'history'],
  ['ctrl+o', 'tool output'], ['ctrl+t', 'thinking'],
  ['ctrl+c', 'clear; twice quits'], ['pgup/pgdn', 'scroll'],
];
/** Below this many columns /help is one column. */
const HELP_TWO_COLUMNS = 72;

/** Pairs as aligned "name  description" cells, two per line from HELP_TWO_COLUMNS columns, else one. */
function helpCells(pairs: readonly HelpPair[], columns: number): string[] {
  const nameWidth = Math.max(...pairs.map(([name]) => name.length)) + 2;
  const cells = pairs.map(([name, description]) => `${name.padEnd(nameWidth)}${description}`);
  if (columns < HELP_TWO_COLUMNS) return cells;
  const cellWidth = Math.max(...cells.map(cell => cell.length)) + 2;
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += 2) lines.push(`${(cells[i] ?? '').padEnd(cellWidth)}${cells[i + 1] ?? ''}`.trimEnd());
  return lines;
}

/** /help for a terminal `columns` wide: commands, keys, and what happens to unfinished work. */
export function helpText(columns: number): string {
  return [...helpCells(HELP_COMMANDS, columns), '', ...helpCells(HELP_KEYS, columns), '',
    'Unfinished work and agents resume on the next launch.'].join('\n');
}

/** Asked before `/tools on`: the tools act on this machine as the user, without a sandbox or approval prompts. */
export const TOOLS_QUESTION = 'Enable read/write/edit/bash with your user permissions for this launch?'
  + ' They run without a sandbox or approval prompts.';

/** Asked before Ctrl+C twice or Ctrl+D exits while something runs. */
export const EXIT_QUESTION = 'Pi or agents are working. Exit anyway? Work resumes on the next launch.';

/** Two Ctrl+C presses within this many ms exit. */
const DOUBLE_CTRL_C = 1000;
/** Below this many columns the editor has no side padding. */
const EDITOR_PADDING_MIN = 50;
/** Below this many rows (a phone with its keyboard open) completion lists 3 items instead of pi-tui's 5. */
const SHORT_ROWS = 20;

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

/** One line computed at render time, hidden below `minWidth` columns. */
class Line implements Component {
  private readonly text: () => string;
  private readonly minWidth: number;
  constructor(text: () => string, minWidth = 0) { this.text = text; this.minWidth = minWidth; }
  invalidate(): void {}
  render(width: number): string[] { return width < this.minWidth ? [] : [truncateToWidth(this.text(), width)]; }
}

/** Text lines the editor shows at most on a terminal `rows` high: about 30% of it, borders included. */
export const editorLines = (rows: number): number => Math.max(2, Math.round(rows * 0.3) - 2);

/**
 * The editor with the app's keys in front of it; `onKey` returns true when it handled the key. On a phone it
 * drops its side padding below EDITOR_PADDING_MIN columns, and shows at most `editorLines(rows)` lines of text
 * (pi-tui's Editor shows max(5, 30% of the rows), which is half of a 15-row screen).
 */
class ChatEditor extends Editor {
  onKey: ((data: string) => boolean) | undefined;
  private hidden = { above: 0, below: 0, border: '' };
  private start = 0;

  override handleInput(data: string): void {
    if (!this.onKey?.(data)) super.handleInput(data);
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    this.hidden.above = hiddenLineCount;
    return super.renderTopBorder(width, hiddenLineCount);
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.hidden.below = hiddenLineCount;
    return this.hidden.border = super.renderBottomBorder(width, hiddenLineCount);
  }

  override render(width: number): string[] {
    this.setPaddingX(width < EDITOR_PADDING_MIN ? 0 : 1);
    this.setAutocompleteMaxVisible(this.tui.terminal.rows < SHORT_ROWS ? 3 : 5);
    const lines = super.render(width);
    // Lines are: top border, text, bottom border (styled, so no text line equals it), then autocomplete.
    const end = lines.indexOf(this.hidden.border, 1);
    const text = lines.slice(1, end), max = editorLines(this.tui.terminal.rows);
    if (end < 0 || text.length <= max) { this.start = 0; return lines; }
    // Keep the cursor's line in view, moving the window only as far as it must. Unfocused (under an overlay)
    // there is no cursor marker, and the window stays.
    const cursor = text.findIndex(line => line.includes(CURSOR_MARKER));
    const last = text.length - max;
    this.start = cursor < 0 ? Math.min(this.start, last) : Math.max(0, Math.min(this.start, cursor, last), cursor - max + 1);
    const { above, below } = this.hidden;
    return [
      super.renderTopBorder(width, above + this.start),
      ...text.slice(this.start, this.start + max),
      super.renderBottomBorder(width, below + text.length - this.start - max),
      ...lines.slice(end + 1),
    ];
  }
}

/**
 * Run the chat in the terminal until the user exits (/exit, Ctrl+D, Ctrl+C twice) or `info.signal` aborts.
 * Ctrl+D and Ctrl+C twice ask first while Pi or an agent is working; /exit does not.
 * The terminal is restored on every path, including a process exit while it runs.
 */
export async function runTui(session: UiSession, info: TuiInfo): Promise<void> {
  if (info.signal?.aborted) return;
  const terminal = info.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const chat = new ChatView(session.chat, theme, info.backlog === undefined ? {} : { backlog: info.backlog });
  const footer = new Footer(() => session.status(), theme);
  const editor = new ChatEditor(tui, theme.editor, { paddingX: 1 });
  const env = info.env ?? process.env;
  // `/model ` completes available models, as in Pi; Enter takes the highlighted one, a second Enter sends.
  const completeModel = async (prefix: string): Promise<AutocompleteItem[] | null> => {
    const needle = prefix.trim().toLowerCase();
    const items = (await session.models().catch(() => []))
      .filter(m => m.available && modelRef(m).toLowerCase().includes(needle))
      .map(m => ({ value: modelRef(m), label: modelRef(m), description: m.name }));
    return items.length ? items : null;
  };
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
    COMMANDS.map(c => (c.name === 'model' ? { ...c, getArgumentCompletions: completeModel } : c)), info.cwd));
  // Hidden on a phone: the footer already shows the model and tools.
  const header = new Line(() => {
    const { model, toolsEnabled } = session.status();
    return `${theme.bold(theme.accent('Pi'))}${theme.dim(` · ${model} · `)}${toolsEnabled ? theme.warning('tools on') : theme.dim('tools off')}`;
  }, NARROW);
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
  let confirming = false;
  let spinner: NodeJS.Timeout | undefined;
  const render = (): void => { if (running) tui.requestRender(); };
  const show: ShowNotice = (text, level = 'info') => { chat.notice(text, level); render(); };
  const spin = (): void => {
    const busy = session.status().busy;
    if (busy && !spinner) spinner = setInterval(() => { footer.tick(); render(); }, spinnerInterval(env, terminal.columns)).unref();
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
  /** Ctrl+C twice or Ctrl+D: exits at once when idle, and asks first while Pi or an agent works. */
  const leave = (): void => {
    const status = session.status();
    if (!status.busy && !status.agents.some(agent => agent.busy)) { void exit(); return; }
    if (confirming) return;
    confirming = true;
    confirm(tui, theme, EXIT_QUESTION).then(
      yes => { confirming = false; if (yes) void exit(); },
      (error: unknown) => { confirming = false; show(`Confirmation failed: ${message(error)}`, 'error'); });
  };
  const stop = (arg = ''): void => {
    // `/stop` is Esc for Pi alone; `/stop all` also stops every agent, `/stop Name` one agent and its subs.
    if (!arg || arg === 'all') session.abort().catch((error: unknown) => show(`Interrupt failed: ${message(error)}`, 'error'));
    if (!arg) return;
    session.stopAgents(arg === 'all' ? undefined : arg).then(
      names => show(names.length ? `Stopped ${names.join(', ')}.` : arg === 'all' ? 'No agents to stop.' : `No agent named ${arg}.`),
      (error: unknown) => show(`Stop failed: ${message(error)}`, 'error'));
  };

  const panel = (open: (tui: TUI, session: UiSession, panelTheme: typeof theme) => Promise<void>): void => {
    // Not awaited: the panel takes focus from the editor and hands it back when it closes.
    open(tui, session, theme).catch((error: unknown) => show(`Panel failed: ${message(error)}`, 'error'));
  };
  const switchModel = (provider: string, id: string): void => {
    session.setModel(provider, id).then(
      () => show(`Model: ${provider}/${id} (from the next message; saved as default)`),
      (error: unknown) => show(`Model not changed: ${message(error)}`, 'error'));
  };
  const model = (arg: string): void => {
    if (!arg) {
      openModelPanel(tui, session, theme).then(
        choice => { if (choice) switchModel(choice.provider, choice.id); },
        (error: unknown) => show(`Panel failed: ${message(error)}`, 'error'));
      return;
    }
    // Ids may hold slashes (openrouter/vendor/model); providers do not.
    const slash = arg.indexOf('/');
    if (slash <= 0 || slash === arg.length - 1) show('Usage: /model provider/id, or /model alone to pick one.', 'warn');
    else switchModel(arg.slice(0, slash), arg.slice(slash + 1));
  };
  const setTools = (enabled: boolean): void => {
    session.setTools(enabled).then(
      () => show(enabled ? 'Coding tools on for this launch' : 'Coding tools off', enabled ? 'warn' : 'info'),
      (error: unknown) => show(`Tools not changed: ${message(error)}`, 'error'));
  };
  const tools = (arg: string): void => {
    const on = session.status().toolsEnabled;
    if (arg === 'off') setTools(false);
    else if (arg === 'on' && on) show('Coding tools on for this launch', 'warn');
    else if (arg === 'on') {
      confirm(tui, theme, TOOLS_QUESTION).then(
        yes => { if (yes) setTools(true); else show('Coding tools stay off.'); },
        (error: unknown) => show(`Confirmation failed: ${message(error)}`, 'error'));
    } else if (arg) show('Usage: /tools, /tools on or /tools off.', 'warn');
    else show(on ? 'Coding tools on for this launch: read, write, edit, bash. /tools off turns them off.'
      : 'Coding tools off. /tools on enables read, write, edit and bash for this launch.');
  };
  const command = (line: string): void => {
    const name = line.slice(1).split(/\s/, 1)[0] ?? '';
    const arg = line.slice(1 + name.length).trim();
    if (name === 'help') show(helpText(terminal.columns));
    else if (name === 'stop') stop(arg);
    else if (name === 'model') model(arg);
    else if (name === 'tools') tools(arg);
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
      stop();
    } else if (matchesKey(data, 'ctrl+c')) {
      const now = Date.now();
      if (now - lastCtrlC < DOUBLE_CTRL_C) { lastCtrlC = 0; leave(); }
      else { editor.setText(''); lastCtrlC = now; }
    } else if (matchesKey(data, 'ctrl+d')) {
      if (editor.getText()) return false;
      leave();
    } else if (matchesKey(data, 'ctrl+o')) {
      chat.toolsExpanded = !chat.toolsExpanded;
    } else if (matchesKey(data, 'ctrl+t')) {
      chat.thinkingExpanded = !chat.thinkingExpanded;
    } else if (matchesKey(data, 'ctrl+l')) {
      model('');
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
