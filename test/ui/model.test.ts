import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, OverlayHandle, OverlayOptions, Terminal } from '@earendil-works/pi-tui';
import { runTui, TOOLS_QUESTION } from '../../src/ui/tui/app.ts';
import type { PanelTheme } from '../../src/ui/tui/panels/frame.ts';
import { openModelPanel } from '../../src/ui/tui/panels/model.ts';
import { theme as appTheme } from '../../src/ui/tui/theme.ts';
import type { ChatFeed, ChatItem, ModelChoice, SessionStatus, UiSession, ViewLine } from '../../src/ui/types.ts';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', backspace: '\x7f', ctrlL: '\x0c' };
const sgr = (on: number, off: number) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`;
// One distinct attribute per role, so the tests can see which style a span got.
const theme: PanelTheme = { accent: sgr(36, 39), dim: sgr(2, 22), error: sgr(31, 39), bold: sgr(1, 22), selected: sgr(7, 27) };

const MODELS: readonly ModelChoice[] = [
  { provider: 'cloud', id: 'big', name: 'Cloud Big', available: false, note: 'needs CLOUD_API_KEY' },
  { provider: 'faux', id: 'b', name: 'Faux B', available: true },
  { provider: 'faux', id: 'a', name: 'Faux A', available: true, note: 'uses your plan' },
];

class EmptyFeed implements ChatFeed {
  items(): readonly ChatItem[] { return []; }
  subscribe(): () => void { return () => undefined; }
  close(): Promise<void> { return Promise.resolve(); }
}

/** A session whose models, model switch and tools switch the test controls and records. */
class FakeSession implements UiSession {
  readonly chat = new EmptyFeed();
  readonly modelCalls: string[] = [];
  readonly toolCalls: boolean[] = [];
  aborts = 0;
  list: Promise<readonly ModelChoice[]> = Promise.resolve(MODELS);
  modelError: Error | undefined;
  private current: SessionStatus = {
    model: 'faux/a', thinkingLevel: 'off', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [],
  };
  private readonly listeners = new Set<() => void>();
  status(): SessionStatus { return this.current; }
  onStatus(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private update(change: Partial<SessionStatus>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener();
  }
  send(): Promise<void> { return Promise.resolve(); }
  abort(): Promise<void> { this.aborts++; return Promise.resolve(); }
  agentChat(): Promise<ChatFeed | undefined> { return Promise.resolve(undefined); }
  memoryView(): readonly ViewLine[] { return []; }
  zoom(): string { return ''; }
  models(): Promise<readonly ModelChoice[]> { return this.list; }
  setModel(provider: string, id: string): Promise<void> {
    this.modelCalls.push(`${provider}/${id}`);
    if (this.modelError) return Promise.reject(this.modelError);
    this.update({ model: `${provider}/${id}` });
    return Promise.resolve();
  }
  setTools(enabled: boolean): Promise<void> {
    this.toolCalls.push(enabled);
    this.update({ toolsEnabled: enabled });
    return Promise.resolve();
  }
}

/** A terminal that records what is written and lets the test type. */
class FakeTerminal implements Terminal {
  output = '';
  readonly kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;
  readonly columns: number;
  readonly rows: number;
  constructor(columns = 100, rows = 24) { this.columns = columns; this.rows = rows; }
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { /* nothing to restore */ }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
  moveBy(): void { /* no cursor */ }
  hideCursor(): void { /* no cursor */ }
  showCursor(): void { /* no cursor */ }
  clearLine(): void { /* no screen */ }
  clearFromCursor(): void { /* no screen */ }
  clearScreen(): void { /* no screen */ }
  setTitle(): void { /* no title */ }
  setProgress(): void { /* no progress */ }
  setProgramStatus(): void { /* no status */ }
  /** Types each key; a plain string longer than one character is typed character by character. */
  type(...keys: string[]): void {
    if (!this.onInput) throw new Error('terminal not started');
    for (const key of keys) for (const data of key.length > 1 && !key.startsWith('\x1b') ? [...key] : [key]) this.onInput(data);
  }
  text(): string { return stripTerminalSequences(this.output); }
}

/** Stands in for the shell's editor: records the keys that reach it. */
class Editor implements Component {
  readonly keys: string[] = [];
  handleInput(data: string): void { this.keys.push(data); }
  render(): string[] { return ['editor']; }
  invalidate(): void { /* nothing cached */ }
}

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** A real pi-tui screen on a fake terminal, an editor with focus, and the picker overlay it shows. */
function harness(columns = 100, rows = 20) {
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
  const panel = (): Component => { const p = overlays.at(-1); assert.ok(p, 'the picker is open'); return p; };
  return {
    tui, editor, terminal,
    // Below 60 columns a panel has no margins.
    raw: (): string[] => panel().render(columns < 60 ? columns : columns - 4),
    screen: (): string => panel().render(columns < 60 ? columns : columns - 4).map(stripTerminalSequences).join('\n'),
  };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
/** The model rows of a picker screen: the cursor, the ✓ mark, then provider/id. */
const modelLines = (screen: string): string[] => screen.split('\n').filter(line => /^│ [→ ] [✓ ] \S+\/\S+/.test(line));

describe('model picker', () => {
  test('on a phone, rows show provider/id only, and the selected model\'s name and note sit above the hint', async () => {
    for (const [columns, rows] of [[40, 15], [56, 20], [120, 24]] as const) {
      const session = new FakeSession(), h = harness(columns, rows);
      const closed = openModelPanel(h.tui, session, theme);
      await tick();
      const width = columns < 60 ? columns : columns - 4;
      for (const line of h.raw()) assert.equal(visibleWidth(line), width, line);
      const screen = h.screen().split('\n');
      if (columns < 60) {
        assert.ok(screen.some(line => /^│ → ✓ faux\/a +│$/.test(line)), screen.join('\n'));
        assert.match(screen.at(-2) ?? '', /^│ Faux A · uses your plan +│$/);
        assert.match(screen.at(-1) ?? '', /^╰─ type to filter · esc close ─+╯$/);
        assert.match(screen[1] ?? '', /^│ Current: faux\/a +│$/);
        h.terminal.type(KEY.down, KEY.down);
        assert.match(h.screen().split('\n').at(-2) ?? '', /Cloud Big · needs CLOUD_API_KEY/);
      } else {
        assert.ok(screen.some(line => /→ ✓ faux\/a\s+Faux A · uses your plan/.test(line)), screen.join('\n'));
      }
      h.terminal.type(KEY.esc);
      await closed;
      stop?.();
    }
  });

  test('says it is loading, then lists the current model first and marked, unavailable ones dim with their note', async () => {
    const session = new FakeSession(), h = harness();
    const { promise, resolve } = Promise.withResolvers<readonly ModelChoice[]>();
    session.list = promise;
    void openModelPanel(h.tui, session, theme);
    assert.match(h.screen(), /Loading models…/);
    resolve(MODELS);
    await tick();
    const screen = h.screen();
    assert.match(screen, /Current: faux\/a/);
    const rows = modelLines(screen);
    assert.equal(rows.length, 3, screen);
    assert.match(rows[0] ?? '', /→ ✓ faux\/a\s+Faux A · uses your plan/);
    assert.match(rows[1] ?? '', /^│\s+faux\/b\s+Faux B/);
    assert.match(rows[2] ?? '', /cloud\/big\s+Cloud Big · needs CLOUD_API_KEY/);
    const cloud = h.raw().find(line => line.includes('cloud/big')) ?? '';
    assert.ok(cloud.includes('\x1b[2m  cloud/big'), 'an unavailable model is dim');
    assert.match(screen, /type to filter · ↑↓ move · enter select · esc close/);
  });

  test('typing filters at once, slashes included; backspace widens it again', async () => {
    const session = new FakeSession(), h = harness();
    void openModelPanel(h.tui, session, theme);
    await tick();
    h.terminal.type('faux/b');
    assert.deepEqual(modelLines(h.screen()).map(line => line.trimEnd()), ['│ →   faux/b     Faux B                                                                        │']);
    assert.match(h.screen(), /filter faux\/b▏/);
    h.terminal.type('zzz');
    assert.match(h.screen(), /No matches\./);
    h.terminal.type(KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace);
    const rows = modelLines(h.screen()).join('\n');
    assert.match(rows, /faux\/a/);
    assert.match(rows, /faux\/b/);
    assert.doesNotMatch(rows, /cloud\/big/);
  });

  test('Enter on an unavailable model shows its note and keeps the picker open; Esc resolves undefined', async () => {
    const session = new FakeSession(), h = harness();
    let result: ModelChoice | undefined | 'open' = 'open';
    const closed = openModelPanel(h.tui, session, theme).then(choice => { result = choice; });
    await tick();
    h.terminal.type(KEY.down, KEY.down, KEY.enter);
    await tick();
    assert.equal(result, 'open');
    assert.match(h.screen(), /cloud\/big: needs CLOUD_API_KEY/);
    assert.ok(!h.raw().some(line => line.includes(theme.error('cloud/big'))), 'the note is a hint, not an error');
    h.terminal.type(KEY.esc);
    await closed;
    assert.equal(result, undefined);
    assert.deepEqual(session.modelCalls, [], 'the picker itself never switches');
    assert.deepEqual(h.editor.keys, [], 'no key reached the editor');
  });

  test('Enter on an available model resolves it; a failed listing shows its error', async () => {
    const session = new FakeSession(), h = harness();
    const picked = openModelPanel(h.tui, session, theme);
    await tick();
    h.terminal.type(KEY.down, KEY.enter);
    assert.deepEqual(await picked, MODELS[1]);

    session.list = Promise.reject(new Error('catalog offline'));
    const failed = openModelPanel(h.tui, session, theme);
    await tick();
    assert.match(h.screen(), /Could not list models: catalog offline/);
    assert.ok(h.raw().some(line => line.includes(theme.error('Could not list models: catalog offline'))));
    h.terminal.type(KEY.esc);
    assert.equal(await failed, undefined);
  });
});

/** Starts the TUI on a fake terminal; returns it with the promise of its exit. */
async function startTui(session: FakeSession): Promise<{ terminal: FakeTerminal; done: Promise<void> }> {
  const terminal = new FakeTerminal();
  const done = runTui(session, { cwd: process.cwd(), terminal });
  await delay(30);
  return { terminal, done };
}

/** The terminal's output since `mark`, without escape sequences. */
const since = (terminal: FakeTerminal, mark: number): string => stripTerminalSequences(terminal.output.slice(mark));

describe('/model and /tools in the chat', () => {
  test('/model opens the picker, Enter switches and says so', async () => {
    const session = new FakeSession();
    const { terminal, done } = await startTui(session);
    terminal.type('/model', KEY.enter);
    await delay(30);
    assert.match(terminal.text(), /→ ✓ faux\/a/);
    terminal.type(KEY.down, KEY.enter);
    await delay(30);
    assert.deepEqual(session.modelCalls, ['faux/b']);
    assert.match(terminal.text(), /Model: faux\/b \(from the next message; saved as default\)/);
    terminal.type('/exit', KEY.enter);
    await done;
  });

  test('Ctrl+L opens the picker, and Esc closes it without interrupting Pi', async () => {
    const session = new FakeSession();
    const { terminal, done } = await startTui(session);
    terminal.type(KEY.ctrlL);
    await delay(30);
    assert.match(terminal.text(), /Loading models…|faux\/b/);
    terminal.type(KEY.esc);
    await delay(80);
    assert.equal(session.aborts, 0);
    assert.deepEqual(session.modelCalls, []);
    terminal.type('/exit', KEY.enter);
    await done;
  });

  test('/model provider/id switches without the picker; a rejection is a red notice', async () => {
    const session = new FakeSession();
    const { terminal, done } = await startTui(session);
    terminal.type('/model openrouter/vendor/m-1', KEY.enter);
    await delay(30);
    assert.deepEqual(session.modelCalls, ['openrouter/vendor/m-1']);
    assert.match(terminal.text(), /Model: openrouter\/vendor\/m-1 \(from the next message; saved as default\)/);
    assert.doesNotMatch(terminal.text(), /Loading models…/);

    session.modelError = new Error('No credentials for cloud.');
    terminal.type('/model cloud/big', KEY.enter);
    await delay(30);
    assert.match(terminal.text(), /Model not changed: No credentials for cloud\./);
    assert.ok(terminal.output.includes(appTheme.error('Model not changed: No credentials for cloud.')), 'the notice is red');

    terminal.type('/model nope', KEY.enter);
    await delay(30);
    assert.match(terminal.text(), /Usage: \/model provider\/id/);
    assert.equal(session.modelCalls.length, 2);
    terminal.type('/exit', KEY.enter);
    await done;
  });

  test('/tools on asks first and only y enables; /tools off needs no confirmation', async () => {
    const session = new FakeSession();
    const { terminal, done } = await startTui(session);
    terminal.type('/tools', KEY.enter);
    await delay(30);
    assert.match(terminal.text(), /Coding tools off\. \/tools on enables read, write, edit and bash for this launch\./);

    for (const answer of ['n', KEY.esc, KEY.enter]) {
      const mark = terminal.output.length;
      terminal.type('/tools on', KEY.enter);
      await delay(30);
      assert.match(since(terminal, mark), /Enable read\/write\/edit\/bash with your user permissions/);
      terminal.type(answer);
      await delay(80);
      assert.deepEqual(session.toolCalls, [], `${JSON.stringify(answer)} does not enable`);
      assert.match(since(terminal, mark), /Coding tools stay off\./);
    }
    assert.equal(session.aborts, 0, 'Esc answered the question, not Pi');

    terminal.type('/tools on', KEY.enter);
    await delay(30);
    terminal.type('y');
    await delay(30);
    assert.deepEqual(session.toolCalls, [true]);
    assert.match(terminal.text(), /Coding tools on for this launch/);
    assert.ok(terminal.output.includes(appTheme.warning('tools on')), 'the footer warns');

    const mark = terminal.output.length;
    terminal.type('/tools off', KEY.enter);
    await delay(30);
    assert.deepEqual(session.toolCalls, [true, false]);
    assert.match(since(terminal, mark), /Coding tools off/);
    assert.doesNotMatch(since(terminal, mark), /Enable read/);
    terminal.type('/exit', KEY.enter);
    await done;
  });

  test('/help lists /model and /tools', async () => {
    const session = new FakeSession();
    const { terminal, done } = await startTui(session);
    terminal.type('/help', KEY.enter);
    await delay(30);
    assert.match(terminal.text(), /\/model {3}pick a model \(ctrl\+l\)/);
    assert.match(terminal.text(), /\/tools {3}coding tools: on, off/);
    assert.match(terminal.text(), /\/stop {4}interrupt Pi \(esc\)/);
    assert.ok(TOOLS_QUESTION.includes('user permissions'));
    terminal.type('/exit', KEY.enter);
    await done;
  });
});
