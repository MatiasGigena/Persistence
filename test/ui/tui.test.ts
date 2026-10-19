import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import type { ChatFeed, ChatItem, ModelChoice, SessionStatus, UiSession, ViewLine } from '../../src/ui/types.ts';
import { runTui } from '../../src/ui/tui/app.ts';
import { ChatView, TOOL_PREVIEW } from '../../src/ui/tui/chat.ts';
import { Footer, footerText } from '../../src/ui/tui/footer.ts';
import type { FooterStatus } from '../../src/ui/tui/footer.ts';
import { theme } from '../../src/ui/tui/theme.ts';

/** An in-memory feed: `set()` replaces the items and notifies, as the session's feed does. */
class FakeFeed implements ChatFeed {
  private list: readonly ChatItem[];
  private readonly listeners = new Set<() => void>();
  constructor(items: readonly ChatItem[] = []) { this.list = items; }
  items(): readonly ChatItem[] { return this.list; }
  set(items: readonly ChatItem[]): void {
    this.list = items;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): Promise<void> { return Promise.resolve(); }
}

const STATUS: SessionStatus = {
  model: 'faux/model-1', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0,
  memory: { messages: 142, unsummarized: 2, active: 3, failed: 1, lastError: undefined, viewBytes: 37 * 1024, viewLines: 12 },
  agents: [],
};

class FakeSession implements UiSession {
  readonly chat: FakeFeed;
  readonly sent: string[] = [];
  aborts = 0;
  private current: SessionStatus = STATUS;
  private readonly listeners = new Set<() => void>();
  constructor(items: readonly ChatItem[] = []) { this.chat = new FakeFeed(items); }
  status(): SessionStatus { return this.current; }
  onStatus(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Changes the status and notifies, as the session does. */
  update(change: Partial<SessionStatus>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }
  send(text: string): Promise<void> { this.sent.push(text); return Promise.resolve(); }
  abort(): Promise<void> { this.aborts++; return Promise.resolve(); }
  agentChat(): Promise<ChatFeed | undefined> { return Promise.resolve(undefined); }
  memoryView(): readonly ViewLine[] { return []; }
  zoom(): string { return ''; }
  models(): Promise<readonly ModelChoice[]> { return Promise.resolve([]); }
  setModel(provider: string, id: string): Promise<void> { this.update({ model: `${provider}/${id}` }); return Promise.resolve(); }
  setTools(enabled: boolean): Promise<void> { this.update({ toolsEnabled: enabled }); return Promise.resolve(); }
}

/** A terminal that records what is written and lets the test type. */
class FakeTerminal implements Terminal {
  output = '';
  stopped = false;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { this.stopped = true; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
  get columns(): number { return 80; }
  get rows(): number { return 24; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  type(...keys: string[]): void {
    if (!this.onInput) throw new Error('terminal not started');
    for (const key of keys) for (const data of key.length > 1 && !key.startsWith('\x1b') ? [...key] : [key]) this.onInput(data);
  }
  /** The text written so far, without escape sequences. */
  text(): string { return stripTerminalSequences(this.output); }
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line).trimEnd());

/** Starts the TUI on a fake terminal; returns it with the promise of its exit. */
async function startTui(session: FakeSession, signal?: AbortSignal): Promise<{ terminal: FakeTerminal; done: Promise<void> }> {
  const terminal = new FakeTerminal();
  const done = runTui(session, { cwd: process.cwd(), terminal, ...signal ? { signal } : {} });
  await delay(30);
  return { terminal, done };
}

test('assistant markdown streams in place', () => {
  const feed = new FakeFeed([
    { kind: 'user', id: 'u1', text: 'hi' },
    { kind: 'assistant', id: 'a1', text: 'Hel', streaming: true },
  ]);
  const view = new ChatView(feed, theme);
  assert.deepEqual(plain(view.render(40)).filter(Boolean), ['❯ hi', '  Hel']);
  feed.set([feed.items()[0] ?? assert.fail(), { kind: 'assistant', id: 'a1', text: 'Hello **world**', streaming: false }]);
  view.sync();
  const lines = plain(view.render(40)).filter(Boolean);
  assert.deepEqual(lines, ['❯ hi', '  Hello world']);
  assert.ok(view.render(40).some(line => line.includes('\x1b[1m')), 'bold is styled, not literal');
});

test('tool output collapses to a preview and expands', () => {
  const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const view = new ChatView(new FakeFeed([
    { kind: 'tool', id: 't1', name: 'read', args: '{"path":"a.txt"}', output, status: 'done' },
  ]), theme);
  const collapsed = plain(view.render(60));
  assert.equal(collapsed[0], '▸ read {"path":"a.txt"} ✓');
  assert.deepEqual(collapsed.slice(1, 1 + TOOL_PREVIEW), ['  line 1', '  line 2', '  line 3', '  line 4']);
  assert.match(collapsed.at(-1) ?? '', /… 6 more lines, ctrl\+o to expand/);
  assert.equal(collapsed.length, TOOL_PREVIEW + 2);
  view.toolsExpanded = true;
  const expanded = plain(view.render(60));
  assert.equal(expanded.length, 11);
  assert.equal(expanded.at(-1), '  line 10');
});

test('reports, notices and collapsed thinking', () => {
  const view = new ChatView(new FakeFeed([
    { kind: 'thinking', id: 'th', text: 'first thought\nsecond thought', streaming: false },
    { kind: 'report', id: 'r1', from: 'Scout', text: 'found the file' },
    { kind: 'notice', id: 'n1', text: 'model failed', level: 'error' },
  ]), theme);
  const lines = plain(view.render(60)).filter(Boolean);
  assert.equal(lines[0], '∴ first thought (+1 lines, ctrl+t)');
  assert.equal(lines[1], '[Scout] found the file');
  assert.equal(lines[2], '! model failed');
  assert.ok(view.render(60).some(line => line.includes('\x1b[38;5;5m') && line.includes('[Scout]')), 'reports use the agent accent');
});

test('the view opens on the last items of the history, then shows every new one', () => {
  const items: ChatItem[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `m${i}` }));
  const feed = new FakeFeed(items);
  const view = new ChatView(feed, theme, { backlog: 2 });
  assert.deepEqual(plain(view.render(20)).filter(Boolean), ['❯ m8', '❯ m9']);
  view.notice('local');
  feed.set([...items, { kind: 'user', id: 'u10', text: 'm10' }]);
  view.sync();
  assert.deepEqual(plain(view.render(20)).filter(Boolean), ['❯ m8', '❯ m9', '· local', '❯ m10']);
});

test('the footer shows the status on one line, truncated to the width', () => {
  const busy: FooterStatus = { ...STATUS, busy: true, queued: 2, agents: [{ busy: true }, { busy: false }] };
  const text = stripTerminalSequences(footerText(busy, theme));
  assert.equal(text, 'faux/model-1 · thinking high · tools off · ⠋ working · 2 queued · mem 142 msgs · 37 KB view'
    + ' · 3 summarizing · 1 failed · 1/2 agents busy');
  assert.ok(footerText(busy, theme).includes(theme.error('1 failed')), 'failures are red');
  const footer = new Footer(() => busy, theme);
  for (const width of [20, 50, 200]) {
    const lines = footer.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0] ?? '') <= width);
  }
  assert.equal(stripTerminalSequences(footerText({ ...STATUS, memory: undefined }, theme)), 'faux/model-1 · thinking high · tools off');
});

test('Enter sends, Esc aborts, Ctrl+D exits and restores the terminal', async () => {
  const session = new FakeSession([{ kind: 'assistant', id: 'a0', text: 'Welcome back', streaming: false }]);
  const { terminal, done } = await startTui(session);
  assert.match(terminal.text(), /Pi · faux\/model-1 · tools off/);
  assert.match(terminal.text(), /Welcome back/);
  assert.match(terminal.text(), /mem 142 msgs/);
  terminal.type('hello', '\r');
  assert.deepEqual(session.sent, ['hello']);
  terminal.type('\x1b');
  await delay(80);
  assert.equal(session.aborts, 1);
  terminal.type('x', '\x04');
  terminal.type('\x15', '\x04');
  await done;
  assert.equal(terminal.stopped, true);
});

test('slash commands dispatch, and Ctrl+C twice exits', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.type('/status', '\r');
  terminal.type('/nope', '\r');
  await delay(30);
  assert.match(terminal.text(), /model faux\/model-1 · thinking high · tools off/);
  assert.match(terminal.text(), /Unknown command \/nope/);
  terminal.type('/agents', '\r');
  await delay(30);
  assert.match(terminal.text(), /No agents yet/);
  terminal.type('\x1b'); // Esc closes the panel, not Pi's run.
  await delay(80);
  assert.equal(session.aborts, 0);
  terminal.type('after panel', '\r');
  assert.deepEqual(session.sent, ['after panel']);
  assert.equal(session.sent.some(text => text.startsWith('/')), false, 'commands are not sent to Pi');
  terminal.type('\x03', '\x03');
  await done;
  assert.equal(terminal.stopped, true);
});

test('the header and footer follow status changes, and tools on is in the warning color', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.output = '';
  session.update({ model: 'faux/model-2', toolsEnabled: true });
  await delay(30);
  assert.match(terminal.text(), /faux\/model-2/);
  assert.match(terminal.text(), /tools on/);
  assert.ok(terminal.output.includes(theme.warning('tools on')), 'tools on is yellow');
  terminal.type('/exit', '\r');
  await done;
});

test('/exit and the host shutdown signal both end the TUI', async () => {
  const first = await startTui(new FakeSession());
  first.terminal.type('/exit', '\r');
  await first.done;
  const shutdown = new AbortController();
  const second = await startTui(new FakeSession(), shutdown.signal);
  shutdown.abort();
  await second.done;
  assert.equal(second.terminal.stopped, true);
  assert.equal(process.listenerCount('exit'), 0, 'no exit listener is left behind');
});
