import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, OverlayHandle, OverlayOptions, Terminal } from '@earendil-works/pi-tui';
import type { AgentInfo } from '../../src/agents/index.ts';
import type { MemoryStatus } from '../../src/memory/index.ts';
import { openAgentsPanel } from '../../src/ui/tui/panels/agents.ts';
import type { PanelTheme } from '../../src/ui/tui/panels/frame.ts';
import { openMemoryPanel, parseMessage, parseZoom } from '../../src/ui/tui/panels/memory.ts';
import type { ChatFeed, ChatItem, SessionStatus, UiSession, ViewLine } from '../../src/ui/types.ts';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b' };
const sgr = (on: number, off: number) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`;
// One distinct attribute per role, so the tests can see which style a span got.
const theme: PanelTheme = { accent: sgr(36, 39), dim: sgr(2, 22), error: sgr(31, 39), bold: sgr(1, 22), selected: sgr(7, 27) };

class FakeTerminal implements Terminal {
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive = false;
  input: (data: string) => void = () => undefined;
  constructor(columns: number, rows: number) { this.columns = columns; this.rows = rows; }
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { /* nothing to restore */ }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(): void { /* the panels are read from their own render() */ }
  moveBy(): void { /* no cursor */ }
  hideCursor(): void { /* no cursor */ }
  showCursor(): void { /* no cursor */ }
  clearLine(): void { /* no screen */ }
  clearFromCursor(): void { /* no screen */ }
  clearScreen(): void { /* no screen */ }
  setTitle(): void { /* no title */ }
  setProgress(): void { /* no progress */ }
  setProgramStatus(): void { /* no status */ }
}

/** Stands in for the shell's editor: records the keys that reach it. */
class Editor implements Component {
  readonly keys: string[] = [];
  handleInput(data: string): void { this.keys.push(data); }
  render(): string[] { return ['editor']; }
  invalidate(): void { /* nothing cached */ }
}

class FakeFeed implements ChatFeed {
  closed = false;
  private list: ChatItem[];
  private readonly listeners = new Set<() => void>();
  constructor(items: ChatItem[]) { this.list = items; }
  items(): readonly ChatItem[] { return this.list; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get subscribers(): number { return this.listeners.size; }
  push(item: ChatItem): void { this.list = [...this.list, item]; for (const l of this.listeners) l(); }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

const memory: MemoryStatus = { messages: 9, unsummarized: 0, active: 1, failed: 2, lastError: undefined, viewBytes: 3072, viewLines: 2 };

class FakeSession implements UiSession {
  readonly chat = new FakeFeed([]);
  agents: AgentInfo[] = [];
  view: ViewLine[] = [];
  zooms = new Map<string, string>();
  feeds = new Map<string, FakeFeed>();
  private readonly listeners = new Set<() => void>();
  status(): SessionStatus {
    return { model: 'faux/model', thinkingLevel: 'off', toolsEnabled: false, busy: false, queued: 0, memory, agents: this.agents };
  }
  onStatus(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get statusListeners(): number { return this.listeners.size; }
  setAgents(agents: AgentInfo[]): void { this.agents = agents; for (const l of this.listeners) l(); }
  send(): Promise<void> { return Promise.resolve(); }
  abort(): Promise<void> { return Promise.resolve(); }
  agentChat(name: string): Promise<ChatFeed | undefined> { return Promise.resolve(this.feeds.get(name)); }
  memoryView(): readonly ViewLine[] { return this.view; }
  zoom(id: number, n: number): string {
    const out = this.zooms.get(`${id}+${n}`);
    if (out === undefined) throw new Error(`No line ${id}+${n}.`);
    return out;
  }
}

// The panels never read the conversation ID, so every fake agent shares the root's.
const agent = (name: string, busy: boolean, role: AgentInfo['role'] = 'main', parent = 'Pi'): AgentInfo =>
  ({ name, role, parent, busy, conversationId: ROOT_CONVERSATION_ID });

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** A real pi-tui screen on a fake terminal, an editor with focus, and the panel overlay it shows. */
function harness(columns = 80, rows = 20) {
  const terminal = new FakeTerminal(columns, rows);
  const tui = new TuiMainScreen(terminal);
  const editor = new Editor();
  tui.addChild(editor);
  tui.setFocus(editor);
  const overlays: Component[] = [];
  const show = tui.showOverlay.bind(tui);
  tui.showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => { overlays.push(component); return show(component, options); };
  tui.start();
  stop = () => tui.stop();
  const panel = (): Component => { const p = overlays.at(-1); assert.ok(p, 'a panel is open'); return p; };
  return {
    tui, editor,
    press: (...keys: string[]): void => { for (const k of keys) terminal.input(k); },
    /** The panel at the width pi-tui gives it (the terminal less the 2-column margins), styles kept. */
    raw: (): string[] => panel().render(columns - 4),
    screen: (): string => panel().render(columns - 4).map(stripTerminalSequences).join('\n'),
  };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('agents panel', () => {
  test('an empty list says how to get agents, and Esc closes it and refocuses the editor', async () => {
    const session = new FakeSession(), h = harness();
    const closed = openAgentsPanel(h.tui, session, theme);
    assert.match(h.screen(), /Agents/);
    assert.match(h.screen(), /No agents yet\. Ask Pi to spawn one\./);
    assert.match(h.screen(), /esc close/);
    h.press(KEY.esc);
    await closed;
    assert.equal(session.statusListeners, 0);
    h.press('x');
    assert.deepEqual(h.editor.keys, ['x']);
  });

  test('rows show name, role, parent and state, a busy agent with an accent dot, and follow status', async () => {
    const session = new FakeSession(), h = harness();
    session.agents = [agent('Ada', true), agent('Bob', false, 'sub', 'Ada')];
    const closed = openAgentsPanel(h.tui, session, theme);
    const rows = h.raw().map(stripTerminalSequences);
    assert.ok(rows.some(r => /→ ● Ada\s+main\s+parent Pi\s+busy/.test(r)), rows.join('\n'));
    assert.ok(rows.some(r => /○ Bob\s+sub\s+parent Ada\s+idle/.test(r)), rows.join('\n'));
    assert.ok(h.raw().some(r => r.includes('\x1b[7m● Ada')), 'the selected row is styled whole');
    assert.ok(h.raw().some(r => r.includes(`${theme.dim('○')} Bob`)), 'an idle dot is dim');
    session.setAgents([agent('Ada', false), agent('Bob', true, 'sub', 'Ada')]);
    assert.match(h.screen(), /● Bob\s+sub\s+parent Ada\s+busy/);
    h.press(KEY.esc);
    await closed;
  });

  test('Enter opens the agent chat live, Esc goes back to the list and closes the feed', async () => {
    const session = new FakeSession(), h = harness();
    session.agents = [agent('Ada', true), agent('Bob', false)];
    const feed = new FakeFeed([
      { kind: 'user', id: 'u1', text: 'Find the bug' },
      { kind: 'assistant', id: 'a1', text: 'Looking at **main.ts**', streaming: false },
      { kind: 'tool', id: 't1', name: 'read', args: '{"path":"main.ts"}', output: '…', status: 'done' },
    ]);
    session.feeds.set('Bob', feed);
    const closed = openAgentsPanel(h.tui, session, theme);
    h.press(KEY.down, KEY.enter);
    await tick();
    const chat = h.screen();
    assert.match(chat, /Agents › Bob/);
    assert.match(chat, /› Find the bug/);
    assert.match(chat, /Looking at main\.ts/);
    assert.match(chat, /✓ read \{"path":"main\.ts"\}/);
    assert.equal(feed.subscribers, 1);
    feed.push({ kind: 'report', id: 'r1', from: 'Cy', text: 'done' });
    assert.match(h.screen(), /\[Cy\] done/);
    h.press(KEY.esc);
    assert.ok(feed.closed);
    assert.equal(feed.subscribers, 0);
    assert.match(h.screen(), /→ ○ Bob/);
    assert.doesNotMatch(h.screen(), /Find the bug/);
    h.press(KEY.esc);
    await closed;
  });
});

describe('memory panel', () => {
  test('rows show id+n dim and the text, the newest selected, under the status header', async () => {
    const session = new FakeSession(), h = harness();
    session.view = [{ id: 0, n: 8, text: 'the early days' }, { id: 8, n: 1, text: 'user: hello' }];
    const closed = openMemoryPanel(h.tui, session, theme);
    const screen = h.screen();
    assert.match(screen, /9 messages · 3\.0 KB view · 1 summarizing · 2 failed/);
    assert.ok(h.raw().some(r => r.includes(theme.error('2 failed'))), 'failures are an error');
    assert.match(screen, / {2}0\+8 {2}the early days/);
    assert.match(screen, /→ 8\+1 {2}user: hello/);
    assert.ok(h.raw().some(r => r.includes(`${theme.dim('0+8')}  the early days`)));
    h.press(KEY.esc);
    await closed;
  });

  test('Enter zooms into a line, then into n = 1, and Esc climbs back twice', async () => {
    const session = new FakeSession(), h = harness();
    session.view = [{ id: 0, n: 4, text: 'four messages' }, { id: 4, n: 1, text: 'pi: latest' }];
    session.zooms.set('0+4', '0+2|first half\n2+2|second half');
    session.zooms.set('2+2', '2+1|user: why?\n3+1|pi: because');
    session.zooms.set('3+1', '3+1|pi: because\n\nthe whole reply');
    const closed = openMemoryPanel(h.tui, session, theme);
    h.press(KEY.up, KEY.enter);
    assert.match(h.screen(), /Memory › 0\+4/);
    assert.match(h.screen(), /→ 0\+2 {2}first half/);
    h.press(KEY.down, KEY.enter);
    assert.match(h.screen(), /Memory › 0\+4 › 2\+2/);
    h.press(KEY.down, KEY.enter);
    assert.match(h.screen(), /Memory › 0\+4 › 2\+2 › 3\+1/);
    assert.match(h.screen(), /pi: because\s*│\n│\s+│\n│ the whole reply/);
    assert.match(h.screen(), /↑↓ scroll/);
    h.press(KEY.esc);
    assert.match(h.screen(), /Memory › 0\+4 › 2\+2 /);
    assert.match(h.screen(), /→ 3\+1 {2}pi: because/);
    h.press(KEY.esc);
    assert.match(h.screen(), /→ 2\+2 {2}second half/);
    h.press(KEY.esc, KEY.esc);
    await closed;
    assert.equal(session.statusListeners, 0);
  });

  test('a zoom that fails shows its error', async () => {
    const session = new FakeSession(), h = harness();
    session.view = [{ id: 0, n: 2, text: 'two' }];
    const closed = openMemoryPanel(h.tui, session, theme);
    h.press(KEY.enter);
    assert.match(h.screen(), /No line 0\+2\./);
    h.press(KEY.esc, KEY.esc);
    await closed;
  });

  test('/ filters the rows by substring', async () => {
    const session = new FakeSession(), h = harness();
    session.view = [{ id: 0, n: 2, text: 'apples' }, { id: 2, n: 1, text: 'pears' }, { id: 3, n: 1, text: 'grapes' }];
    const closed = openMemoryPanel(h.tui, session, theme);
    h.press('/', 'a', 'p', 'p');
    assert.match(h.screen(), /apples/);
    assert.doesNotMatch(h.screen(), /pears|grapes/);
    h.press(KEY.esc);
    assert.match(h.screen(), /pears/);
    h.press(KEY.esc);
    await closed;
  });

  test('every line fits the width, and long text is cut with an ellipsis', async () => {
    const session = new FakeSession(), h = harness(30, 12);
    session.view = [{ id: 0, n: 1, text: 'a very long line of memory that cannot possibly fit' }];
    const closed = openMemoryPanel(h.tui, session, theme);
    const lines = h.raw();
    for (const line of lines) assert.equal(visibleWidth(line), 26, line);
    assert.ok(lines.map(stripTerminalSequences).some(l => /0\+1 {2}a very lon.*…/.test(l)), lines.join('\n'));
    assert.equal(lines.length, 10);
    h.press(KEY.esc);
    await closed;
  });

  test('zoom output parses into lines and a message with its page note', () => {
    assert.deepEqual(parseZoom('0+2|a|b\n2+2|(not summarized yet: zoom(2, 2))'),
      [{ id: 0, n: 2, text: 'a|b' }, { id: 2, n: 2, text: '(not summarized yet: zoom(2, 2))' }]);
    assert.deepEqual(parseMessage('5+1|user: a|b'), { note: undefined, body: 'user: a|b' });
    assert.deepEqual(parseMessage('5+1 (page 1 of 2; zoom(5, 1, page) for the others)|pi: x'),
      { note: '(page 1 of 2; zoom(5, 1, page) for the others)', body: 'pi: x' });
  });
});
