// The overlay panels' shared parts: a bordered, near-full-screen frame holding a stack of views
// (a breadcrumb title, an optional header, the top view, a one-line key hint), a selectable list,
// and a scrollable text view. Only pi-tui; colors come from the shell through PanelTheme.
import { decodeKittyPrintable, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Keybinding, TUI } from '@earendil-works/pi-tui';

/** The colors a panel uses; the shell passes its palette in. Each takes plain text and returns it styled. */
export interface PanelTheme {
  readonly accent: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly error: (text: string) => string;
  readonly bold: (text: string) => string;
  /** The selected row of a list. */
  readonly selected: (text: string) => string;
}

/** One level of a panel. */
export interface PanelView {
  /** Its breadcrumb segment. */
  readonly title: string;
  /** Its one-line key hint. */
  readonly hint: string;
  /** At most `height` lines, each at most `width` columns. */
  render(width: number, height: number): string[];
  /** Handles a key; returns false to let the frame treat it (Esc goes back). */
  handleInput(data: string): boolean;
  dispose?(): void;
}

const ELLIPSIS = '…';
/** Whether `data` is `binding`, as the user configured it (Pi's selectors use the same bindings). */
const is = (data: string, binding: Keybinding): boolean => getKeybindings().matches(data, binding);

/** Text from the host made safe to draw: tabs become spaces, other control characters (and so ANSI) go. */
export function clean(text: string): string {
  return text.replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

/** `line` cut or padded to exactly `width` columns. */
function fit(line: string, width: number): string {
  const cut = visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line;
  return cut + ' '.repeat(Math.max(0, width - visibleWidth(cut)));
}

/** The frame: a stack of views in a thin rounded border. Esc pops a view, and closes at the top. */
export class PanelFrame implements Component {
  /** Called once, when the last view is popped or `close()` runs. */
  onClose: () => void = () => undefined;
  private readonly stack: PanelView[];
  private readonly tui: TUI;
  private readonly theme: PanelTheme;
  private readonly header: (() => string) | undefined;
  private closed = false;

  constructor(tui: TUI, theme: PanelTheme, root: PanelView, header?: () => string) {
    this.tui = tui;
    this.theme = theme;
    this.stack = [root];
    this.header = header;
  }

  get isClosed(): boolean { return this.closed; }
  top(): PanelView | undefined { return this.stack.at(-1); }

  push(view: PanelView): void {
    if (this.closed) { view.dispose?.(); return; }
    this.stack.push(view);
    this.tui.requestRender();
  }

  /** Pops the top view; popping the root closes the panel. */
  back(): void {
    if (this.stack.length <= 1) { this.close(); return; }
    this.stack.pop()?.dispose?.();
    this.tui.requestRender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (let view = this.stack.pop(); view; view = this.stack.pop()) view.dispose?.();
    this.onClose();
  }

  handleInput(data: string): void {
    const view = this.top();
    if (view?.handleInput(data)) return;
    if (is(data, 'tui.select.cancel')) this.back();
  }

  invalidate(): void { /* views render from live data each frame */ }

  render(width: number): string[] {
    const view = this.top();
    if (!view || width < 8) return [];
    const { dim, bold } = this.theme;
    const inner = width - 4, height = Math.max(6, this.tui.terminal.rows - 2);
    const crumbs = this.stack.map((v, i) => (i === this.stack.length - 1 ? bold(v.title) : dim(v.title))).join(dim(' › '));
    const rule = (left: string, label: string, right: string): string => {
      const text = truncateToWidth(label, width - 6, ELLIPSIS);
      return dim(`${left}─ `) + text + dim(` ${'─'.repeat(Math.max(0, width - 5 - visibleWidth(text)))}${right}`);
    };
    const header = this.header ? [this.header(), ''] : [];
    const bodyHeight = height - 2 - header.length;
    const body = [...header, ...view.render(inner, bodyHeight).slice(0, bodyHeight)];
    while (body.length < height - 2) body.push('');
    return [
      rule('╭', crumbs, '╮'),
      ...body.map(line => `${dim('│')} ${fit(line, inner)} ${dim('│')}`),
      rule('╰', dim(view.hint), '╯'),
    ];
  }
}

/** Shows `frame` as a near-full-screen overlay; resolves when it closes. Hiding the overlay hands focus back. */
export function openPanel(tui: TUI, frame: PanelFrame): Promise<void> {
  return new Promise(resolve => {
    // pi-tui remembers the focused component (the editor) when the overlay opens, and hide() refocuses it.
    const handle = tui.showOverlay(frame, { anchor: 'center', width: '100%', maxHeight: '100%', margin: { top: 1, bottom: 1, left: 2, right: 2 } });
    frame.onClose = () => { handle.hide(); tui.requestRender(); resolve(); };
  });
}

/** One row of a list: `plain` is drawn when selected (in theme.selected) and matched by the filter. */
export interface Row {
  readonly key: string;
  readonly plain: string;
  readonly styled: string;
}

export interface ListOptions {
  readonly title: string;
  readonly theme: PanelTheme;
  /** Read on every frame, so a live source stays current. */
  readonly rows: () => readonly Row[];
  readonly empty: () => string;
  readonly onOpen: (row: Row) => void;
  /** Select the last row first, and keep following it while it stays selected. */
  readonly followEnd?: boolean;
  /** `/` filters the rows by substring. */
  readonly filterable?: boolean;
  /** Whether this is the panel's first level, for the hint. */
  readonly root?: boolean;
  readonly dispose?: () => void;
}

/** A selectable list. Selection follows its row's key when rows change. */
export class ListView implements PanelView {
  readonly title: string;
  private readonly options: ListOptions;
  private key: string | undefined;
  private index = 0;
  private scroll = 0;
  private height = 10;
  private atEnd: boolean;
  private filter = '';
  private typing = false;

  constructor(options: ListOptions) {
    this.options = options;
    this.title = options.title;
    this.atEnd = options.followEnd ?? false;
  }

  get hint(): string {
    if (this.typing) return 'type to filter · enter keep · esc clear';
    const filter = this.options.filterable ? ' · / filter' : '';
    return `↑↓ move · enter open${filter} · esc ${this.options.root ? 'close' : 'back'}`;
  }

  dispose(): void { this.options.dispose?.(); }

  /** The visible rows and the selected index among them. */
  private current(): { rows: readonly Row[]; index: number } {
    const needle = this.filter.toLowerCase();
    const rows = needle ? this.options.rows().filter(r => r.plain.toLowerCase().includes(needle)) : this.options.rows();
    const byKey = this.key === undefined ? -1 : rows.findIndex(r => r.key === this.key);
    const index = this.atEnd ? rows.length - 1 : byKey >= 0 ? byKey : Math.min(this.index, rows.length - 1);
    return { rows, index: Math.max(0, index) };
  }

  private select(rows: readonly Row[], index: number): void {
    this.index = Math.max(0, Math.min(index, rows.length - 1));
    this.key = rows[this.index]?.key;
    this.atEnd = (this.options.followEnd ?? false) && this.index === rows.length - 1;
  }

  handleInput(data: string): boolean {
    if (this.typing) return this.handleFilter(data);
    const { rows, index } = this.current();
    const page = Math.max(1, this.height - 1);
    if (is(data, 'tui.select.up')) this.select(rows, index - 1);
    else if (is(data, 'tui.select.down')) this.select(rows, index + 1);
    else if (is(data, 'tui.select.pageUp')) this.select(rows, index - page);
    else if (is(data, 'tui.select.pageDown')) this.select(rows, index + page);
    else if (matchesKey(data, 'home')) this.select(rows, 0);
    else if (matchesKey(data, 'end')) this.select(rows, rows.length - 1);
    else if (is(data, 'tui.select.confirm')) {
      const row = rows[index];
      if (row) { this.select(rows, index); this.options.onOpen(row); }
    } else if (data === '/' && this.options.filterable) this.typing = true;
    else return false;
    return true;
  }

  private handleFilter(data: string): boolean {
    if (is(data, 'tui.select.cancel')) { this.filter = ''; this.typing = false; }
    else if (is(data, 'tui.select.confirm')) this.typing = false;
    else if (matchesKey(data, 'backspace')) this.filter = this.filter.slice(0, -1);
    else {
      const char = decodeKittyPrintable(data) ?? data;
      if (char.length !== 1 || char < ' ' || char === '\x7f') return true;
      this.filter += char;
    }
    this.key = undefined;
    this.index = 0;
    this.atEnd = false;
    return true;
  }

  render(width: number, height: number): string[] {
    const { theme } = this.options;
    const showFilter = this.typing || this.filter !== '';
    this.height = Math.max(1, height - (showFilter ? 1 : 0));
    const { rows, index } = this.current();
    const lines: string[] = [];
    if (rows.length === 0) lines.push(theme.dim(this.filter ? 'No matches.' : this.options.empty()));
    this.scroll = Math.max(0, Math.min(this.scroll, index, rows.length - this.height));
    if (index >= this.scroll + this.height) this.scroll = index - this.height + 1;
    for (const [i, row] of rows.slice(this.scroll, this.scroll + this.height).entries()) {
      lines.push(this.scroll + i === index
        ? theme.accent('→ ') + theme.selected(truncateToWidth(row.plain, width - 2, ELLIPSIS))
        : `  ${truncateToWidth(row.styled, width - 2, ELLIPSIS)}`);
    }
    if (showFilter) {
      while (lines.length < this.height) lines.push('');
      lines.push(theme.accent(`/${this.filter}${this.typing ? '▏' : ''}`));
    }
    return lines;
  }
}

export interface TextOptions {
  readonly title: string;
  /** The whole text at `width`, read on every frame. */
  readonly lines: (width: number) => readonly string[];
  /** Start at the end, and keep following it while scrolled to the end (a live feed). */
  readonly follow?: boolean;
  readonly dispose?: () => void;
}

/** A read-only, scrollable block of lines. */
export class TextView implements PanelView {
  readonly title: string;
  readonly hint = '↑↓ scroll · pgup/pgdn page · esc back';
  private readonly options: TextOptions;
  private offset = 0;
  private max = 0;
  private height = 10;
  private following: boolean;

  constructor(options: TextOptions) {
    this.options = options;
    this.title = options.title;
    this.following = options.follow ?? false;
  }

  dispose(): void { this.options.dispose?.(); }

  handleInput(data: string): boolean {
    const page = Math.max(1, this.height - 1);
    let next = this.offset;
    if (is(data, 'tui.select.up')) next--;
    else if (is(data, 'tui.select.down')) next++;
    else if (is(data, 'tui.select.pageUp')) next -= page;
    else if (is(data, 'tui.select.pageDown')) next += page;
    else if (matchesKey(data, 'home')) next = 0;
    else if (matchesKey(data, 'end')) next = this.max;
    else return false;
    this.offset = Math.max(0, Math.min(next, this.max));
    this.following = (this.options.follow ?? false) && this.offset >= this.max;
    return true;
  }

  render(width: number, height: number): string[] {
    const lines = this.options.lines(width);
    this.height = height;
    this.max = Math.max(0, lines.length - height);
    this.offset = this.following ? this.max : Math.min(this.offset, this.max);
    return lines.slice(this.offset, this.offset + height).map(l => truncateToWidth(l, width, ELLIPSIS));
  }
}

/** Plain text wrapped to `width`, paragraph by paragraph. */
export function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(clean(text.replace(/\r\n?/g, '\n')), width);
}
