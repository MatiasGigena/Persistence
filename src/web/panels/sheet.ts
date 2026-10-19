// The sheet: one modal dialog (a bottom sheet on a phone, a side panel on a desktop) holding a stack of views.
// Deeper views show breadcrumbs back to each level; Escape and the Android back gesture go up one level first.
import { el } from '../chat-view.ts';
import type { Link } from '../link.ts';
import type { NoticeLevel } from '../../protocol/messages.ts';
import type { Store } from '../store.ts';

/** One level of the sheet. `render` fills its container once; `dispose` runs when the level leaves the stack. */
export interface View {
  readonly title: string;
  render(body: HTMLElement): void;
  dispose?(): void;
}

/** What every panel gets. */
export interface PanelContext {
  readonly store: Store;
  readonly link: Link;
  readonly sheet: Sheet;
  /** Shows text in the chat, as the terminal's notices. */
  notice(text: string, level?: NoticeLevel): void;
}

interface Level { readonly view: View; readonly body: HTMLElement }

/** Finds a required element of index.html by id and type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html lacks #${id}`);
  return element;
}

export class Sheet {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly body: HTMLElement;
  private stack: Level[] = [];

  constructor(dialog: HTMLDialogElement) {
    this.dialog = dialog;
    this.title = byId('sheet-title', HTMLHeadingElement);
    this.crumbs = byId('sheet-crumbs', HTMLElement);
    this.body = byId('sheet-body', HTMLDivElement);
    byId('sheet-close', HTMLButtonElement).addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', event => {
      if (this.stack.length < 2) return;
      event.preventDefault();
      this.popTo(this.stack.length - 2);
    });
    dialog.addEventListener('close', () => this.clear());
    // A tap on the backdrop (the dialog itself, outside its content) closes.
    dialog.addEventListener('click', event => { if (event.target === dialog) this.close(); });
  }

  get isOpen(): boolean { return this.dialog.open; }

  /** Opens the sheet on `view`, replacing whatever it showed. */
  open(view: View): void {
    this.clear();
    this.push(view);
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Shows `view` on top of the current level. */
  push(view: View): void {
    const body = el('div', 'sheet-level');
    this.stack.push({ view, body });
    view.render(body);
    this.show();
  }

  /** Re-titles the top level (an agent's chat once it is known to have ended, and so on). */
  retitle(): void { this.show(); }

  close(): void {
    if (this.dialog.open) this.dialog.close();
    else this.clear();
  }

  private popTo(depth: number): void {
    while (this.stack.length > depth + 1) this.stack.pop()?.view.dispose?.();
    this.show();
  }

  private clear(): void {
    for (const level of this.stack.reverse()) level.view.dispose?.();
    this.stack = [];
    this.body.replaceChildren();
    this.crumbs.replaceChildren();
  }

  private show(): void {
    const top = this.stack.at(-1);
    if (!top) return;
    this.title.textContent = top.view.title;
    this.crumbs.replaceChildren(...this.stack.slice(0, -1).map((level, depth) => {
      const button = el('button', 'crumb', level.view.title);
      button.type = 'button';
      button.addEventListener('click', () => this.popTo(depth));
      return button;
    }));
    this.crumbs.hidden = this.stack.length < 2;
    this.body.replaceChildren(top.body);
    this.body.scrollTop = 0;
  }
}

/** A list of tappable rows: each a button with a main line, an optional detail line, and a trailing note. */
export interface Row {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly aside?: string;
  /** A leading mark; `none` keeps its room, so marked and unmarked rows align. */
  readonly mark?: 'busy' | 'idle' | 'current' | 'none';
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Fills `list` with `rows`; `onPick` gets the tapped row's key. */
export function renderRows(list: HTMLElement, rows: readonly Row[], onPick: (key: string) => void): void {
  list.replaceChildren(...rows.map(row => {
    const li = el('li');
    const button = el('button', `row${row.className ? ` ${row.className}` : ''}`);
    button.type = 'button';
    button.disabled = row.disabled ?? false;
    if (row.mark) button.append(el('span', `row-mark mark-${row.mark}`));
    const text = el('span', 'row-text');
    text.append(el('span', 'row-label', row.label));
    if (row.detail) text.append(el('span', 'row-detail', row.detail));
    button.append(text);
    if (row.aside) button.append(el('span', 'row-aside', row.aside));
    button.addEventListener('click', () => onPick(row.key));
    li.append(button);
    return li;
  }));
}
