import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import type { AttachedLink, ChatFeed, ChatItem, LinkState, ModelChoice, NoticeLevel, SessionStatus, UiSession, ViewLine } from '../../src/protocol/session.ts';
import { EXIT_QUESTION, LINK_CLOSED, commands, currentStep, editorLines, helpText, isCommand, runTui } from '../../src/ui/tui/app.ts';
import { statusText } from '../../src/ui/text.ts';
import type { TuiInfo } from '../../src/ui/tui/app.ts';
import { ChatView, clean, TOOL_PREVIEW, TOOL_PREVIEW_NARROW } from '../../src/ui/tui/chat.ts';
import { toolSummary } from '../../src/ui/text.ts';
import { Footer, footerText, SPIN_FAST, SPIN_SLOW, STEP_WIDTH, spinnerInterval } from '../../src/ui/tui/footer.ts';
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
  stopped: (string | undefined)[] = [];
  stopAgents(name?: string): Promise<readonly string[]> {
    this.stopped.push(name);
    return name === 'ghost' ? Promise.reject(new Error('No agent named ghost. The agents are Ada, Bob.')) : Promise.resolve([name ?? 'Ada']);
  }
  archiveAgents(): Promise<readonly string[]> { return Promise.resolve([]); }
  restoreAgent(): Promise<readonly string[]> { return Promise.resolve([]); }
  agentChat(): Promise<ChatFeed | undefined> { return Promise.resolve(undefined); }
  memoryView(): Promise<readonly ViewLine[]> { return Promise.resolve([]); }
  zoom(): Promise<string> { return Promise.resolve(''); }
  private readonly noticeListeners = new Set<(text: string, level: NoticeLevel) => void>();
  onNotice(listener: (text: string, level: NoticeLevel) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }
  /** Sends a host notice, as the session's `notify()` does. */
  notify(text: string, level: NoticeLevel): void { for (const listener of this.noticeListeners) listener(text, level); }
  models(): Promise<readonly ModelChoice[]> { return Promise.resolve([]); }
  setModel(provider: string, id: string): Promise<void> { this.update({ model: `${provider}/${id}` }); return Promise.resolve(); }
  setTools(enabled: boolean): Promise<void> { this.update({ toolsEnabled: enabled }); return Promise.resolve(); }
  thinkingLevels(): Promise<readonly string[]> { return Promise.resolve(['low', 'medium', 'high']); }
  setThinkingLevel(level: string): Promise<void> { this.update({ thinkingLevel: level }); return Promise.resolve(); }
}

/** A terminal that records what is written and lets the test type. */
class FakeTerminal implements Terminal {
  output = '';
  stopped = false;
  readonly columns: number;
  readonly rows: number;
  private onInput: ((data: string) => void) | undefined;
  constructor(columns = 80, rows = 24) { this.columns = columns; this.rows = rows; }
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { this.stopped = true; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
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
  /**
   * The screen as the alternate-screen renderer leaves it, one string per row. It writes each row whole, as
   * "move to row;1, clear the line, the line", so the last write to a row is what it shows.
   */
  screen(): string[] {
    const rows = Array.from({ length: this.rows }, () => '');
    const parts = this.output.split(/\x1b\[(\d+);1H\x1b\[2K/);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const text = stripTerminalSequences((parts[i + 1] ?? '').split(/\x1b\[\d+;\d+H/)[0] ?? '');
      rows[Number(parts[i]) - 1] = text;
    }
    return rows;
  }
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line).trimEnd());

/** Polls `check` instead of sleeping a fixed time, so a loaded machine only makes a test slower. */
async function until(check: () => boolean, what: string, wait = (): Promise<unknown> => delay(20)): Promise<void> {
  for (const end = Date.now() + 5_000; !check(); await wait()) if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
}

/** Input is handled synchronously but drawn on a later tick: output past `mark` means the frame after the input is drawn. */
const drawn = (terminal: FakeTerminal, mark: number): Promise<void> => until(() => terminal.output.length > mark, 'a frame after the input');

/** Starts the TUI on a fake terminal; returns it with the promise of its exit. */
async function startTui(session: FakeSession, signal?: AbortSignal, terminal = new FakeTerminal(),
  extra: Partial<TuiInfo> = {}): Promise<{ terminal: FakeTerminal; done: Promise<void> }> {
  const done = runTui(session, { cwd: process.cwd(), terminal, env: {}, ...signal ? { signal } : {}, ...extra });
  await until(() => /tools o(n|ff)/.test(terminal.text()) || terminal.stopped, 'the first frame');
  return { terminal, done };
}

test('assistant markdown streams in place', () => {
  const feed = new FakeFeed([
    { kind: 'user', id: 'u1', text: 'hi' },
    { kind: 'assistant', id: 'a1', text: 'Hel', streaming: true },
  ]);
  const view = new ChatView(feed, theme);
  assert.deepEqual(plain(view.render(60)).filter(Boolean), ['❯ hi', '  Hel']);
  feed.set([feed.items()[0] ?? assert.fail(), { kind: 'assistant', id: 'a1', text: 'Hello **world**', streaming: false }]);
  view.sync();
  const lines = plain(view.render(60)).filter(Boolean);
  assert.deepEqual(lines, ['❯ hi', '  Hello world']);
  assert.ok(view.render(60).some(line => line.includes('\x1b[1m')), 'bold is styled, not literal');
  assert.deepEqual(plain(view.render(40)).filter(Boolean), ['❯ hi', 'Hello world'], 'no Markdown padding on a phone');
});

test('tool output collapses to a preview and expands', () => {
  const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const view = new ChatView(new FakeFeed([
    { kind: 'tool', id: 't1', name: 'read', args: '{"path":"a.txt"}', output, status: 'done' },
  ]), theme);
  const collapsed = plain(view.render(60));
  assert.equal(collapsed[0], '✓ read a.txt');
  assert.deepEqual(collapsed.slice(1, 1 + TOOL_PREVIEW), ['  line 1', '  line 2', '  line 3', '  line 4']);
  assert.match(collapsed.at(-1) ?? '', /… 6 more lines, ctrl\+o to expand/);
  assert.equal(collapsed.length, TOOL_PREVIEW + 2);
  view.toolsExpanded = true;
  const expanded = plain(view.render(60));
  assert.equal(expanded.length, 11);
  assert.equal(expanded.at(-1), '  line 10');
});

test('tool output loses hyperlinks and other escapes whole, and carriage returns overwrite as in a terminal', () => {
  const output = [
    'see \x1b]8;;file:///tmp/a.txt\x07a.txt\x1b]8;;\x1b\\ here',
    '\x1b[1mbold\x1b(B\x1b[m plain\x1b7\x1b8',
    'fetching 10%\rfetching 100%\r',
    'abcdef\rXY',
    'crlf\r\nnext',
  ].join('\n');
  const view = new ChatView(new FakeFeed([{ kind: 'tool', id: 't1', name: 'bash', args: '{"command":"ls"}', output, status: 'done' }]), theme);
  view.toolsExpanded = true;
  assert.deepEqual(plain(view.render(60)), ['✓ bash ls', '  see a.txt here', '  bold plain', '  fetching 100%', '  XYcdef', '  crlf', '  next']);
  assert.equal(clean('\x1b[31mred\x1b[0m ok'), 'red ok', 'the panels share the same cleaning');
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
  const view = new ChatView(feed, theme, { backlog: 2, history: '/mem' });
  assert.deepEqual(plain(view.render(80)).filter(Boolean), ['· 8 earlier items not shown; /mem browses the whole chat', '❯ m8', '❯ m9']);
  view.notice('local');
  feed.set([...items.slice(3), { kind: 'user', id: 'u10', text: 'm10' }]);
  view.sync();
  assert.deepEqual(plain(view.render(30)).filter(Boolean), ['· 5 earlier items · /mem', '❯ m8', '❯ m9', '· local', '❯ m10'],
    'the count follows the feed, and is short on a phone');
  assert.deepEqual(plain(new ChatView(new FakeFeed(items.slice(0, 2)), theme, { backlog: 2 }).render(80)), ['❯ m0', '', '❯ m1'],
    'no count when the whole history shows');
  const other = new ChatView(new FakeFeed(items), theme, { backlog: 2 });
  assert.deepEqual(plain(other.render(80)).filter(Boolean)[0], '· 8 earlier items not shown', 'no command unless one is given');
  assert.deepEqual(plain(other.render(30)).filter(Boolean)[0], '· 8 earlier items');
});

test("the TUI's chat points at /mem for the history it leaves out", async () => {
  const items: ChatItem[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `m${i}` }));
  const { terminal, done } = await startTui(new FakeSession(items));
  assert.ok(terminal.screen().includes('· 4 earlier items not shown; /mem browses the whole chat'), terminal.screen().join('\n'));
  terminal.type('\x04');
  await done;
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

test('the footer shows the running step next to the spinner, only while busy', () => {
  const step = 'bash cd ~/pi-durable-instance && npm test';
  const busy: FooterStatus = { ...STATUS, memory: undefined, busy: true, step };
  assert.equal(stripTerminalSequences(footerText(busy, theme)),
    `faux/model-1 · thinking high · tools off · ⠋ working · ${step}`);
  assert.equal(stripTerminalSequences(footerText({ ...busy, busy: false }, theme)), 'faux/model-1 · thinking high · tools off');
  const long = stripTerminalSequences(footerText({ ...busy, step: `bash ${'x'.repeat(200)}` }, theme));
  const shown = long.split(' · ').at(-1) ?? '';
  assert.ok(visibleWidth(shown) <= STEP_WIDTH && shown.endsWith('…'), 'a long step is cut');
  const narrow = stripTerminalSequences(footerText(busy, theme, 0, 40));
  assert.match(narrow, /tools off/);
  assert.match(narrow, /busy/);
});

test('currentStep is the newest running tool call', () => {
  const tool = (id: string, name: string, args: string, status: 'running' | 'done' | 'error'): ChatItem =>
    ({ kind: 'tool', id, name, args, output: '', status });
  assert.equal(currentStep([]), undefined);
  assert.equal(currentStep([tool('t1', 'bash', '{"command":"ls"}', 'done')]), undefined);
  assert.equal(currentStep([
    tool('t1', 'bash', '{"command":"ls"}', 'running'),
    { kind: 'assistant', id: 'a1', text: 'reading', streaming: false },
    tool('t2', 'read', '{"path":"src/a.ts"}', 'running'),
    tool('t3', 'bash', '{"command":"pwd"}', 'done'),
  ]), 'read src/a.ts');
  assert.equal(currentStep([tool('t1', 'list_agents', '{}', 'running')]), 'list_agents');
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
  await until(() => session.aborts === 1, 'the abort');
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
  await until(() => /Unknown command \/nope/.test(terminal.text()), 'both replies');
  assert.match(terminal.text(), /model faux\/model-1 · thinking high · tools off/);
  assert.match(terminal.text(), /Unknown command \/nope/);
  terminal.type('/agents', '\r');
  await until(() => /No agents yet/.test(terminal.text()), 'the agents panel');
  terminal.type('\x1b'); // Esc closes the panel, not Pi's run.
  terminal.type('after panel', '\r');
  assert.deepEqual(session.sent, ['after panel'], 'the editor has focus back, so the Esc was handled');
  assert.equal(session.aborts, 0);
  assert.equal(session.sent.some(text => text.startsWith('/')), false, 'commands are not sent to Pi');
  terminal.type('\x03', '\x03');
  await done;
  assert.equal(terminal.stopped, true);
});

test('/status says where the tools run when a client routes them to a machine', () => {
  assert.doesNotMatch(statusText(STATUS), /tools run on/);
  const lines = statusText({ ...STATUS, machine: { machineId: 'm1', label: 'laptop', cwd: '/home/u/src' } }).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['model faux/model-1 · thinking high · tools off', 'tools run on laptop in /home/u/src']);
});

test('a line that starts with a path is sent to Pi, not taken as a command', async () => {
  assert.equal(isCommand('/status'), true);
  assert.equal(isCommand('/model claude-cli/opus'), true);
  assert.equal(isCommand('/'), true);
  assert.equal(isCommand('/etc/hosts is empty, why?'), false);
  assert.equal(isCommand('/tmp/x.log'), false);
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  const mark = terminal.output.length;
  terminal.type('/etc/hosts is empty, why?', '\r');
  await drawn(terminal, mark);
  assert.deepEqual(session.sent, ['/etc/hosts is empty, why?']);
  assert.doesNotMatch(terminal.text(), /Unknown command/);
  terminal.type('/exit', '\r');
  await done;
});

test('a message that was not sent says so, and ↑ brings it back to the editor', async () => {
  const session = new FakeSession();
  session.send = () => Promise.reject(new Error('the link is down'));
  const { terminal, done } = await startTui(session);
  terminal.type('my long message', '\r');
  await until(() => /Not sent/.test(terminal.text()), 'the failure');
  assert.match(terminal.text(), /Not sent: the link is down \(↑ brings the message back\)/);
  terminal.type('\x1b[A', '\r');
  await until(() => (terminal.text().match(/Not sent/g) ?? []).length > 1, 'the second failure');
  assert.equal((terminal.text().match(/Not sent: the link is down/g) ?? []).length, 2, '↑ then Enter resends it');
  terminal.type('/exit', '\r');
  await done;
});

test('the first Ctrl+C says in the footer that a second one quits, until the second would no longer count', async t => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session, undefined, new FakeTerminal(40, 15));
  const footer = (): string => terminal.screen().find(row => row.includes('tools off')) ?? '';
  assert.doesNotMatch(footer(), /ctrl\+c again/);
  // Mock time from here: both the 1 s window and the renderer's frame timer run on it, so each poll ticks it.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const tick = async (): Promise<void> => { t.mock.timers.tick(20); await new Promise(resolve => setImmediate(resolve)); };
  terminal.type('draft', '\x03');
  await until(() => /ctrl\+c again/.test(footer()), 'the hint', tick);
  assert.match(footer(), /ctrl\+c again to quit/, 'kept on a phone-width footer');
  t.mock.timers.tick(1_000);
  await until(() => !/ctrl\+c again/.test(footer()), 'the hint to expire', tick);
  assert.equal(terminal.stopped, false);
  terminal.type('\x03', '\x03');
  await done;
  assert.ok(footerText({ ...STATUS, hint: 'ctrl+c again to detach' }, theme, 0, 20).includes('ctrl+c again to detach'));
});

test('/effort NAME sets the effort; /effort alone opens the picker on the current level, and Enter takes the highlighted one', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.type('/effort LOW', '\r');
  await until(() => /Effort: low \(from the next request; saved as default\)/.test(terminal.text()), 'the notice');
  assert.equal(session.status().thinkingLevel, 'low', 'any case');
  terminal.type('/effort', '\r');
  await until(() => /✓ low/.test(terminal.text()) && /balanced/.test(terminal.text()), 'the picker');
  terminal.type('\x1b[B', '\r'); // down to medium, then Enter
  await until(() => session.status().thinkingLevel === 'medium', 'medium');
  terminal.type('/effort', '\r');
  await until(() => /✓ medium/.test(terminal.text()), 'the picker again');
  terminal.type('\x1b[B', '\r'); // from medium, the current level, down to high
  await until(() => session.status().thinkingLevel === 'high', 'high');
  terminal.type('/exit', '\r');
  await done;
});

test('the header and footer follow status changes, and tools on is in the warning color', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.output = '';
  session.update({ model: 'faux/model-2', toolsEnabled: true });
  await until(() => /tools on/.test(terminal.text()) && terminal.output.includes(theme.warning('tools on')), 'the new status');
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

// Phone widths: 40 and 56 columns are a phone in portrait and landscape; 120 checks the wide look.
const WIDTHS = [40, 56, 120] as const;
const fits = (lines: readonly string[], width: number): void => {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
};

test('toolSummary shows one meaningful argument', () => {
  assert.equal(toolSummary('bash', '{"command":"ls -la\\n  src","timeout":5}'), 'ls -la src');
  assert.equal(toolSummary('read', '{"path":"src/a.ts","offset":3}'), 'src/a.ts');
  assert.equal(toolSummary('write', '{"path":"b.md","content":"long text"}'), 'b.md');
  assert.equal(toolSummary('edit', '{"path":"c.ts","edits":[]}'), 'c.ts');
  assert.equal(toolSummary('zoom', '{"id":12,"n":4}'), '12+4');
  assert.equal(toolSummary('zoom', '{"id":7}'), '7+1');
  assert.equal(toolSummary('zoom', '{"id":"Scout"}'), 'Scout');
  assert.equal(toolSummary('spawn_agent', '{"name":"Scout","task":"find it"}'), 'Scout');
  assert.equal(toolSummary('send_message', '{"to":"Pi","text":"done"}'), 'Pi');
  assert.equal(toolSummary('bash', '{"command":"echo \\"hi'), 'echo "hi', 'partial JSON while streaming');
  assert.equal(toolSummary('list_agents', '{}'), '');
  assert.equal(toolSummary('date', '{"id":3}'), '{"id":3}');
  const long = toolSummary('mystery', JSON.stringify({ text: 'x'.repeat(200) }));
  assert.ok(long.endsWith('…') && visibleWidth(long) <= 60, long);
});

test('on a phone the chat is compact, and no line is wider than the screen', () => {
  const output = Array.from({ length: 10 }, (_, i) => `output line ${i + 1} ${'with words '.repeat(i)}`).join('\n');
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: `please look at ${'a long request '.repeat(8)}` },
    { kind: 'thinking', id: 'th', text: 'first thought\nsecond thought', streaming: false },
    { kind: 'tool', id: 't1', name: 'bash', args: `{"command":"grep -rn ${'pattern '.repeat(12)}src"}`, output, status: 'done' },
    { kind: 'tool', id: 't2', name: 'read', args: '{"path":"src/ui/tui/app.ts"}', output: '', status: 'running' },
    { kind: 'assistant', id: 'a1', text: `# Heading\n\n${'Some **markdown** text. '.repeat(10)}\n\n- one\n- two`, streaming: false },
    { kind: 'report', id: 'r1', from: 'Scout', text: 'found the file '.repeat(6) },
    { kind: 'notice', id: 'n1', text: 'model failed '.repeat(8), level: 'error' },
  ];
  for (const width of WIDTHS) {
    const view = new ChatView(new FakeFeed(items), theme, { backlog: items.length });
    const narrow = width < 60;
    for (const [tools, thinking] of [[false, false], [true, true]] as const) {
      view.toolsExpanded = tools;
      view.thinkingExpanded = thinking;
      fits(view.render(width), width);
    }
    view.toolsExpanded = false;
    view.thinkingExpanded = false;
    const lines = plain(view.render(width));
    const head = lines.findIndex(line => line.startsWith('✓ bash grep -rn pattern'));
    assert.ok(head >= 0, lines.join('\n'));
    const preview = narrow ? TOOL_PREVIEW_NARROW : TOOL_PREVIEW;
    assert.equal(lines[head + 1], `${narrow ? ' ' : '  '}output line 1`);
    assert.equal(lines[head + preview + 1], narrow ? ` +${10 - preview} lines ^o` : `  … ${10 - preview} more lines, ctrl+o to expand`);
    assert.ok(lines.includes('… read src/ui/tui/app.ts'), 'a running tool is marked first');
    assert.ok(lines.includes(narrow ? '∴ first thought +1 ^t' : '∴ first thought (+1 lines, ctrl+t)'));
    assert.equal(lines.find(line => line.includes('Heading'))?.startsWith(narrow ? 'Heading' : '  Heading'), true, 'Markdown padding');
  }
  const long = new ChatView(new FakeFeed([
    { kind: 'thinking', id: 'th', text: `${'a long thought '.repeat(8)}\nmore`, streaming: false },
    { kind: 'tool', id: 't', name: 'bash', args: '{"command":"ls"}', output: 'with words '.repeat(8), status: 'done' },
  ]), theme).render(40).map(line => stripTerminalSequences(line));
  assert.deepEqual(long.filter(line => line.includes('…') || line.includes('...')).map(line => line.endsWith('… +1 ^t') || line.endsWith('…')),
    [true, true], `cut lines end in one ellipsis character, as the footer's and the panels' do:\n${long.join('\n')}`);
});

const BUSY: FooterStatus = {
  ...STATUS, model: 'claude-cli/claude-sonnet-4-5', busy: true, queued: 2, agents: [{ busy: true }, { busy: false }, { busy: true }],
};

test('the footer fills by priority and never drops the tools state', () => {
  const at = (status: FooterStatus, width: number): string => stripTerminalSequences(new Footer(() => status, theme).render(width)[0] ?? '');
  for (const width of [...WIDTHS, 20, 12]) {
    for (const status of [STATUS, BUSY, { ...BUSY, toolsEnabled: true }, { ...STATUS, memory: undefined }]) {
      const line = at(status, width);
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.match(line, status.toolsEnabled ? /tools on/ : /tools off/, `${width}: ${line}`);
    }
  }
  assert.equal(at(BUSY, 40), 'tools off · ⠋ busy · 2 queued · 2/3 ag');
  assert.equal(at(BUSY, 56), 'claude-sonnet-… · tools off · ⠋ busy · 2 queued · 2/3 ag', 'the long model id is cut to the room left');
  assert.equal(at(BUSY, 52), 'tools off · ⠋ busy · 2 queued · 2/3 ag', 'and dropped when that is too little');
  const hermes = { ...STATUS, model: 'openrouter/nousresearch/hermes-3-llama-3.1-405b-instruct-extended' };
  assert.equal(at(hermes, 70), 'nousresearch/hermes-3-llama-3.1-405b-instruct-extended · tools off',
    'a model too long with its provider shows its id');
  assert.equal(at(hermes, 60), 'nousresearch/hermes-3-llama-3.1-405b-instruct-e… · tools off');
  const command = 'bash cd /home/sample/projects/app && npm run build -- --watch=false --verbose';
  assert.equal(at({ ...BUSY, step: command }, 80), 'tools off · ⠋ working · bash cd /home/sample/projects/app && npm run build -- -…',
    'a long step is cut to the room left, not dropped');
  assert.equal(at({ ...BUSY, model: 'claude-cli/haiku' }, 56), 'haiku · tools off · ⠋ busy · 2 queued · 2/3 ag');
  assert.equal(at(STATUS, 40), 'model-1 · tools off · 1 failed');
  assert.equal(at(STATUS, 56), 'model-1 · think high · tools off · mem 37KB · 1 failed');
  assert.equal(at(BUSY, 120), 'claude-cli/claude-sonnet-4-5 · tools off · ⠋ working · 2 queued'
    + ' · mem 142 msgs · 37 KB view · 1 failed · 2/3 agents busy', 'thinking and summaries go first');
  assert.equal(at(BUSY, 200), 'claude-cli/claude-sonnet-4-5 · thinking high · tools off · ⠋ working · 2 queued'
    + ' · mem 142 msgs · 37 KB view · 3 summarizing · 1 failed · 2/3 agents busy');
  assert.equal(at(BUSY, 12), 'tools off');
  assert.equal(at({ ...BUSY, toolsEnabled: true }, 5), 'tool…', 'cut, never dropped');
  // Two segments that are never dropped: the separator between them counts, so a third does not push tools off.
  const reconnecting = { ...STATUS, reconnecting: true };
  for (let width = 26; width <= 40; width++) assert.match(at(reconnecting, width), /reconnecting… · .*tools off/, `${width}`);
});

test('the footer marks a chat scrolled up from its end, until it is back at the end', async () => {
  const items: ChatItem[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `m${i}` }));
  for (const [columns, mark] of [[80, '↓ more below (pgdn)'], [40, '↓ pgdn']] as const) {
    const { terminal, done } = await startTui(new FakeSession(items), undefined, new FakeTerminal(columns, 12), { backlog: 30 });
    const footer = (): string => terminal.screen().find(row => row.includes('tools off')) ?? assert.fail(terminal.screen().join('\n'));
    assert.ok(!footer().includes(mark), footer());
    const marked = (): boolean => terminal.screen().some(row => row.includes('tools off') && row.includes(mark));
    terminal.type('\x1b[5~');
    await until(marked, 'the mark');
    assert.ok(footer().includes(mark), footer());
    terminal.type('\x1b[6~', '\x1b[6~', '\x1b[6~');
    await until(() => !marked(), 'the mark to go');
    assert.ok(!footer().includes(mark), footer());
    terminal.type('\x04');
    await done;
  }
});

test('the spinner slows down over SSH and on a narrow screen', () => {
  assert.equal(spinnerInterval({}, 120), SPIN_FAST);
  assert.equal(spinnerInterval({ SSH_CONNECTION: '10.0.0.2 5555 10.0.0.1 22' }, 120), SPIN_SLOW);
  assert.equal(spinnerInterval({}, 59), SPIN_SLOW);
  assert.equal(SPIN_SLOW, 250);
});

test('/help is one column below 72 columns, and two from there', () => {
  for (const width of WIDTHS) {
    const lines = helpText(width).split('\n');
    fits(lines.slice(0, -1), Math.min(width, 72));
    assert.ok(lines.some(line => (width < 72 ? /^\/stop {4}stop Pi \(esc\) · all · Name$/ : /^\/stop {4}stop Pi \(esc\) · all · Name +\/exit {4}close/).test(line)), lines.join('\n'));
    const view = new ChatView(new FakeFeed(), theme);
    view.notice(helpText(width));
    fits(view.render(width), width);
  }
  assert.ok(helpText(71).split('\n').length > helpText(72).split('\n').length + 5);
});

test('on a phone the header is hidden, the screen fits, and the editor stays small', async () => {
  for (const [columns, rows] of [[40, 15], [56, 20], [120, 24]] as const) {
    const session = new FakeSession([
      { kind: 'tool', id: 't1', name: 'bash', args: '{"command":"ls"}', output: 'a\nb\nc\nd\ne', status: 'done' },
      { kind: 'assistant', id: 'a0', text: 'Welcome back '.repeat(12), streaming: false },
    ]);
    const { terminal, done } = await startTui(session, undefined, new FakeTerminal(columns, rows));
    const first = terminal.screen();
    assert.equal(first[0]?.startsWith('Pi · faux/model-1'), columns >= 60, first.join('\n'));
    terminal.type('/help', '\r');
    for (let i = 1; i <= 9; i++) terminal.type(`line ${i}`, '\n');
    await until(() => terminal.screen().some(row => row.includes('line 9')), 'the typed lines');
    const screen = terminal.screen();
    fits(screen, columns);
    assert.ok(screen.some(row => row.includes('tools off')), screen.join('\n'));
    const borders = screen.flatMap((row, i) => (/^─+( [↑↓] \d+ more ─+)?$/.test(row) ? [i] : []));
    const [top = -1, bottom = -1] = borders.slice(-2);
    assert.equal(bottom - top - 1, Math.min(editorLines(rows), 5), screen.join('\n'));
    assert.match(screen[top] ?? '', /↑ \d+ more/, 'the hidden lines are counted');
    assert.equal(screen[bottom - 1]?.trim(), '', 'the cursor line, empty after the last newline, is shown');
    assert.match(screen[bottom - 2] ?? '', columns < 50 ? /^line 9/ : /^ line 9/, 'no side padding below 50 columns');
    terminal.type('\x03', '/exit', '\r');
    await done;
  }
});

test('/stop interrupts Pi, as Esc does', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.type('/stop', '\r');
  await until(() => /Nothing to stop/.test(terminal.text()), 'the idle notice');
  assert.equal(session.aborts, 1);
  assert.deepEqual(session.sent, [], '/stop is not sent to Pi');
  assert.match(terminal.text(), /Nothing to stop: Pi is idle\./);
  session.update({ agents: [{ name: 'Scout', role: 'main', parent: 'Pi', busy: true }] });
  terminal.type('/stop', '\r');
  await until(() => /Pi is idle;/.test(terminal.text()), 'the agents notice');
  assert.match(terminal.text(), /Pi is idle; 1 agent is working: \/stop all stops them\./);
  session.update({ busy: true });
  const mark = terminal.output.length;
  terminal.type('/stop', '\r');
  terminal.type('\x1b');
  await drawn(terminal, mark);
  assert.equal(session.aborts, 4);
  assert.doesNotMatch(stripTerminalSequences(terminal.output.slice(mark)), /Pi is idle|Nothing to stop/, 'silent while Pi works');
  terminal.type('/exit', '\r');
  await done;
});

test('/stop all stops Pi and every agent; /stop Name stops one agent', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  terminal.type('/stop all', '\r');
  await until(() => /Stopped Ada\./.test(terminal.text()), 'Ada stopped');
  assert.equal(session.aborts, 1);
  terminal.type('/stop Bob', '\r');
  await until(() => /Stopped Bob\./.test(terminal.text()), 'Bob stopped');
  assert.equal(session.aborts, 1, 'a named stop leaves Pi running');
  terminal.type('/stop ghost', '\r');
  await until(() => /No agent named ghost\./.test(terminal.text()), 'the unknown name');
  assert.deepEqual(session.stopped, [undefined, 'Bob', 'ghost']);
  assert.match(terminal.text(), /Stopped Ada\./);
  assert.match(terminal.text(), /Stopped Bob\./);
  assert.match(terminal.text(), /No agent named ghost\. The agents are Ada, Bob\./, 'the session\'s refusal, as it worded it');
  assert.deepEqual(session.sent, []);
  terminal.type('/exit', '\r');
  await done;
});

test('Ctrl+D and Ctrl+C twice ask first only while Pi or an agent works', async () => {
  const idle = await startTui(new FakeSession());
  idle.terminal.type('\x04');
  await idle.done;
  assert.doesNotMatch(idle.terminal.text(), /Exit anyway/);

  const session = new FakeSession();
  session.update({ busy: true });
  const { terminal, done } = await startTui(session);
  terminal.type('\x04');
  await until(() => /Exit anyway\?/.test(terminal.text()), 'the question');
  assert.match(terminal.text(), /Pi or agents are working\. Exit anyway\?/);
  assert.ok(EXIT_QUESTION.includes('Work resumes on the next launch.'));
  const answered = terminal.output.length;
  terminal.type('n');
  await drawn(terminal, answered); // the frame that hides the question, after the answer settled
  assert.equal(terminal.stopped, false, 'any key but y keeps the chat open');
  session.update({ busy: false, agents: [{ name: 'Scout', role: 'main', parent: 'Pi', busy: true }] });
  const mark = terminal.output.length;
  terminal.type('\x03', '\x03');
  await until(() => /Exit anyway\?/.test(stripTerminalSequences(terminal.output.slice(mark))), 'the second question');
  assert.match(stripTerminalSequences(terminal.output.slice(mark)), /Exit anyway\?/, 'a busy agent asks too');
  terminal.type('y');
  await done;
  assert.equal(terminal.stopped, true);
});

/** An attached TUI's link to a server, which the test moves between states. */
class FakeLink implements AttachedLink {
  private current: LinkState = 'ready';
  private readonly listeners = new Set<() => void>();
  state(): LinkState { return this.current; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get subscribers(): number { return this.listeners.size; }
  set(state: LinkState): void { this.current = state; for (const listener of this.listeners) listener(); }
}

test('host notices show in the chat, and the TUI unsubscribes on exit', async () => {
  const session = new FakeSession();
  const { terminal, done } = await startTui(session);
  session.notify('Memory: compaction failed', 'warn');
  await until(() => /compaction failed/.test(terminal.text()), 'the notice');
  assert.match(terminal.text(), /! Memory: compaction failed/);
  terminal.type('/exit', '\r');
  await done;
  session.notify('after exit', 'info');
  assert.doesNotMatch(terminal.text(), /after exit/);
});

test('attached: Ctrl+D detaches at once even while Pi works, and /help and /exit say detach', async () => {
  const session = new FakeSession(), link = new FakeLink();
  session.update({ busy: true });
  const { terminal, done } = await startTui(session, undefined, new FakeTerminal(), { attached: link });
  terminal.type('/help', '\r');
  await until(() => /keep working on the server/.test(terminal.text()), 'the help');
  assert.match(terminal.text(), /\/exit +detach \(ctrl\+d when empty\)/);
  assert.match(terminal.text(), /keep working on the server after you detach/);
  assert.equal(commands(true).find(c => c.name === 'exit')?.description, 'Detach; the server keeps working');
  assert.equal(commands().find(c => c.name === 'exit')?.description, 'Close; unfinished work resumes next launch');
  terminal.type('\x04');
  await done;
  assert.doesNotMatch(terminal.text(), /Exit anyway/);
  assert.equal(link.subscribers, 0);
});

test('attached: the footer says reconnecting… while the link is down, and a closed link exits with a notice', async () => {
  const session = new FakeSession(), link = new FakeLink();
  const { terminal, done } = await startTui(session, undefined, new FakeTerminal(40, 15), { attached: link });
  assert.doesNotMatch(terminal.text(), /reconnecting/);
  link.set('reconnecting');
  await until(() => terminal.screen().some(row => row.includes('tools off') && row.includes('reconnecting')), 'the reconnecting footer');
  const footer = terminal.screen().find(row => row.includes('tools off'));
  assert.match(footer ?? '', /reconnecting…/, 'kept on a phone-width footer');
  terminal.output = '';
  link.set('ready');
  await until(() => terminal.screen().some(row => row.includes('tools off') && !row.includes('reconnecting')), 'the ready footer');
  assert.doesNotMatch(terminal.screen().find(row => row.includes('tools off')) ?? '', /reconnecting/);
  link.set('closed');
  await done;
  assert.equal(terminal.stopped, true);
  // Wrapped at 40 columns: compare the words.
  const words = (text: string): string => text.replace(/[\s!│]+/g, ' ');
  assert.ok(words(terminal.text()).includes(words(LINK_CLOSED)), 'the notice is left in scrollback');
});

test('attached to a link that is already closed, the TUI exits at once', async () => {
  const link = new FakeLink();
  link.set('closed');
  const { done } = await startTui(new FakeSession(), undefined, new FakeTerminal(), { attached: link });
  await done;
});
