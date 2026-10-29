// The overlay panels' shared parts: a bordered, near-full-screen frame holding a stack of views
// (a breadcrumb title, an optional header, the top view, a one-line key hint), a selectable list,
// a scrollable text view, and a one-key confirmation box. Only pi-tui; colors come from the shell
// through PanelTheme, NARROW from the theme, and `clean` from the chat. Below NARROW columns (a phone)
// the frame fills the screen, hints are short, and lists show compact rows with the selection's detail
// above the hint.
import { decodeKittyPrintable, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Keybinding, TUI } from '@earendil-works/pi-tui';
import { clean } from '../chat.ts';
import { NARROW } from '../theme.ts';

export { clean };

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
  /** Its one-line key hint; `narrow` asks for a short one. */
  hint(narrow: boolean): string;
  /** More about the selection, shown above the hint on a narrow screen, where rows are compact. */
  detail?(): string | undefined;
  /** At most `height` lines, each at most `width` columns; `narrow` asks for compact rows. */
  render(width: number, height: number, narrow: boolean): string[];
  /** Handles a key; returns false to let the frame treat it (Esc goes back). */
  handleInput(data: string): boolean;
  dispose?(): void;
}

const ELLIPSIS = '…';
/** Lines of a selection's detail shown on a narrow screen. */
const DETAIL_LINES = 3;
/** Whether `data` is `binding`, as the user configured it (Pi's selectors use the same bindings). */
const is = (data: string, binding: Keybinding): boolean => getKeybindings().matches(data, binding);

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
    const narrow = this.tui.terminal.columns < NARROW;
    const inner = width - 4, height = Math.max(6, this.tui.terminal.rows - 2 * panelMargin(this.tui.terminal.columns));
    const crumbs = this.stack.map((v, i) => (i === this.stack.length - 1 ? bold(v.title) : dim(v.title))).join(dim(' › '));
    const rule = (left: string, label: string, right: string): string => {
      const text = truncateToWidth(label, width - 6, ELLIPSIS);
      return dim(`${left}─ `) + text + dim(` ${'─'.repeat(Math.max(0, width - 5 - visibleWidth(text)))}${right}`);
    };
    const header = this.header ? [this.header(), ''] : [];
    const detail = narrow ? view.detail?.() : undefined;
    const footer = detail ? wrap(detail, inner).slice(0, DETAIL_LINES).map(dim) : [];
    const bodyHeight = Math.max(1, height - 2 - header.length - footer.length);
    const body = [...header, ...view.render(inner, bodyHeight, narrow).slice(0, bodyHeight)];
    while (body.length < height - 2 - footer.length) body.push('');
    return [
      rule('╭', crumbs, '╮'),
      ...[...body, ...footer].map(line => `${dim('│')} ${fit(line, inner)} ${dim('│')}`),
      rule('╰', dim(view.hint(narrow)), '╯'),
    ];
  }
}

/** The panels' distance from the screen's edges: none on a narrow screen. */
const panelMargin = (columns: number): number => (columns < NARROW ? 0 : 1);

/** Shows `frame` as a near-full-screen overlay; resolves when it closes. Hiding the overlay hands focus back. */
export function openPanel(tui: TUI, frame: PanelFrame): Promise<void> {
  return new Promise(resolve => {
    // pi-tui remembers the focused component (the editor) when the overlay opens, and hide() refocuses it.
    const m = panelMargin(tui.terminal.columns);
    const handle = tui.showOverlay(frame, { anchor: 'center', width: '100%', maxHeight: '100%', margin: { top: m, bottom: m, left: 2 * m, right: 2 * m } });
    frame.onClose = () => { handle.hide(); tui.requestRender(); resolve(); };
  });
}

/** One row of a list: `plain` is drawn when selected (in theme.selected) and matched by the filter. */
export interface Row {
  readonly key: string;
  readonly plain: string;
  readonly styled: string;
  /** Shorter forms for a narrow screen (default: the same). */
  readonly compact?: { readonly plain: string; readonly styled: string };
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
  /** The hint's word for Enter (default "open"). */
  readonly verb?: string;
  /** Typing filters at once, as in Pi's selectors: `/` is a plain character, and Esc closes even while filtering. */
  readonly typeToFilter?: boolean;
  /** The filter the list opens with (with `typeToFilter`). */
  readonly filter?: string;
  /** Whether this is the panel's first level, for the hint. */
  readonly root?: boolean;
  /** What a narrow screen shows of the selected row besides its compact form. */
  readonly detail?: (row: Row) => string | undefined;
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
    this.filter = options.filter ?? '';
  }

  hint(narrow: boolean): string {
    if (this.typing) return narrow ? 'enter keep · esc clear' : 'type to filter · enter keep · esc clear';
    const enter = `enter ${this.options.verb ?? 'open'}`, esc = `esc ${this.options.root ? 'close' : 'back'}`;
    if (this.options.typeToFilter) return narrow ? `type to filter · ${esc}` : `type to filter · ↑↓ move · ${enter} · ${esc}`;
    return `${narrow ? '' : '↑↓ move · '}${enter}${this.options.filterable ? ' · / filter' : ''} · ${esc}`;
  }

  detail(): string | undefined {
    const { rows, index } = this.current();
    const row = rows[index];
    return row && this.options.detail?.(row);
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
    } else if (this.options.typeToFilter) return this.handleFilter(data);
    else if (data === '/' && this.options.filterable) this.typing = true;
    else return false;
    return true;
  }

  private handleFilter(data: string): boolean {
    if (is(data, 'tui.select.cancel')) {
      if (this.options.typeToFilter) return false;
      this.filter = '';
      this.typing = false;
    } else if (is(data, 'tui.select.confirm')) this.typing = false;
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

  render(width: number, height: number, narrow = false): string[] {
    const { theme } = this.options;
    const showFilter = this.typing || this.filter !== '';
    this.height = Math.max(1, height - (showFilter ? 1 : 0));
    const { rows, index } = this.current();
    const lines: string[] = [];
    if (rows.length === 0) lines.push(theme.dim(this.filter ? 'No matches.' : this.options.empty()));
    this.scroll = Math.max(0, Math.min(this.scroll, index, rows.length - this.height));
    if (index >= this.scroll + this.height) this.scroll = index - this.height + 1;
    for (const [i, row] of rows.slice(this.scroll, this.scroll + this.height).entries()) {
      const shown = narrow ? row.compact ?? row : row;
      lines.push(this.scroll + i === index
        ? theme.accent('→ ') + theme.selected(truncateToWidth(shown.plain, width - 2, ELLIPSIS))
        : `  ${truncateToWidth(shown.styled, width - 2, ELLIPSIS)}`);
    }
    if (showFilter) {
      while (lines.length < this.height) lines.push('');
      const live = this.options.typeToFilter ?? false;
      lines.push(theme.accent(`${live ? 'filter ' : '/'}${this.filter}${this.typing || live ? '▏' : ''}`));
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
  hint(narrow: boolean): string { return narrow ? '↑↓ pgup/pgdn · esc back' : '↑↓ scroll · pgup/pgdn page · esc back'; }
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
  return wrapTextWithAnsi(clean(text), width);
}

/** A question in a small box. Only `y` says yes; any other key, Esc and Enter included, says no. */
class ConfirmBox implements Component {
  onAnswer: (yes: boolean) => void = () => undefined;
  private readonly theme: PanelTheme;
  private readonly question: string;

  constructor(theme: PanelTheme, question: string) {
    this.theme = theme;
    this.question = question;
  }

  handleInput(data: string): void {
    const key = decodeKittyPrintable(data) ?? data;
    this.onAnswer(key === 'y' || key === 'Y');
  }

  invalidate(): void { /* renders from its fixed text */ }

  render(width: number): string[] {
    if (width < 8) return [];
    const { dim, bold, accent } = this.theme, inner = width - 4;
    const row = (line: string): string => `${dim('│')} ${fit(line, inner)} ${dim('│')}`;
    return [
      dim(`╭${'─'.repeat(width - 2)}╮`),
      ...wrap(this.question, inner).map(line => row(bold(line))),
      row(''),
      row(`${accent('y')} ${dim('yes ·')} ${accent('any other key')} ${dim('no')}`),
      dim(`╰${'─'.repeat(width - 2)}╯`),
    ];
  }
}

/** Widest confirmation box; narrower screens get one as wide as they are. */
const CONFIRM_WIDTH = 60;

/** Asks `question` in a centered box over the chat; resolves on the first key, true only for `y`. */
export function confirm(tui: TUI, theme: PanelTheme, question: string): Promise<boolean> {
  return new Promise(resolve => {
    const box = new ConfirmBox(theme, question);
    const handle = tui.showOverlay(box, { anchor: 'center', width: Math.min(CONFIRM_WIDTH, tui.terminal.columns) });
    box.onAnswer = yes => { box.onAnswer = () => undefined; handle.hide(); tui.requestRender(); resolve(yes); };
  });
}
