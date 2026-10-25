// The sheet: one modal dialog (a bottom sheet on a phone, a side panel on a desktop) holding a stack of views.
// Deeper views show breadcrumbs back to each level; Escape and the Android back gesture go up one level first.
//
// Motion: the dialogs here slide or pop in by a CSS transition out of their `is-out` pose, and leave by going back
// to it before they close (see `showDialog` and `closeDialog`). Transitions, not keyframes, so a sheet closed while it
// is still arriving (or opened again while leaving) turns around from where it is. A new level slides in from the
// right, a level gone back to from the left.
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

// ------------------------------------------------------------------ dialog motion

/** The class that holds a dialog in its hidden pose (styles.css): off screen for the sheet, faded for the confirm. */
const OUT = 'is-out';
/** Extra wait past the computed transition before a close goes ahead without its `transitionend`. */
const CLOSE_SLACK_MS = 60;

/** The longest transition (duration plus delay) on `element` as styled now, in milliseconds. */
function transitionMs(element: Element): number {
  const style = getComputedStyle(element);
  const times = (list: string): number[] => list.split(',').map(part => {
    const value = parseFloat(part);
    if (!Number.isFinite(value)) return 0;
    return part.trim().endsWith('ms') ? value : value * 1000;
  });
  const durations = times(style.transitionDuration);
  const delays = times(style.transitionDelay);
  return Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] ?? 0)));
}

/** Opens `dialog` as a modal that transitions in from its `is-out` pose (also where `@starting-style` is missing). */
export function showDialog(dialog: HTMLDialogElement): void {
  dialog.classList.add(OUT);
  dialog.showModal();
  // Style the hidden pose once, backdrop included, so dropping the class below runs the transition in.
  void getComputedStyle(dialog).transform;
  void getComputedStyle(dialog, '::backdrop').opacity;
  dialog.classList.remove(OUT);
}

/**
 * Closes `dialog` after its exit transition: back to the `is-out` pose, then `close(returnValue)` on its
 * `transitionend` (or a timeout, should that never come). Returns a function that calls the close off and brings the
 * dialog back. The `close` event comes as ever, once the dialog really closes; the class stays until it is shown again.
 */
export function closeDialog(dialog: HTMLDialogElement, returnValue?: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(timer);
    dialog.removeEventListener('transitionend', onEnd);
  };
  const finish = (): void => {
    stop();
    if (dialog.open) dialog.close(returnValue);
  };
  // Only the dialog's own transitions: its children's (a switch, a row) and its backdrop's bubble here too.
  function onEnd(event: TransitionEvent): void {
    if (event.target === dialog && !event.pseudoElement) finish();
  }
  dialog.classList.add(OUT);
  const wait = transitionMs(dialog);
  if (wait <= 0) {
    finish();
    return () => undefined;
  }
  dialog.addEventListener('transitionend', onEnd);
  timer = setTimeout(finish, wait + CLOSE_SLACK_MS);
  return () => {
    stop();
    dialog.classList.remove(OUT);
  };
}

/**
 * Adds `className`, a one-shot entrance animation, and drops it when it ends, so the element shown again (a level
 * gone back to) does not replay it.
 */
export function playOnce(element: HTMLElement, className: string): void {
  element.classList.add(className);
  const done = (event: AnimationEvent): void => {
    if (event.target !== element) return;
    element.removeEventListener('animationend', done);
    element.classList.remove(className);
    element.style.removeProperty('animation-delay');
  };
  element.addEventListener('animationend', done);
}

/** Fades in content that replaces a skeleton. */
export function fadeIn(element: HTMLElement): void { playOnce(element, 'fade-in'); }

// ------------------------------------------------------------------ the sheet

export class Sheet {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly body: HTMLElement;
  private stack: Level[] = [];
  /** Calls off a close in progress (the sheet still leaving); set from `close()` until the dialog closes. */
  private leaving: (() => void) | undefined;

  constructor(dialog: HTMLDialogElement) {
    this.dialog = dialog;
    this.title = byId('sheet-title', HTMLHeadingElement);
    this.crumbs = byId('sheet-crumbs', HTMLElement);
    this.body = byId('sheet-body', HTMLDivElement);
    byId('sheet-close', HTMLButtonElement).addEventListener('click', () => this.close());
    // Escape and the Android back gesture: up one level, or close with the exit. Should the browser not let the
    // event be held (no user activation since the last), the dialog closes at once and `close` tidies up.
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.leaving) return;
      if (this.stack.length > 1) this.popTo(this.stack.length - 2);
      else this.close();
    });
    dialog.addEventListener('close', () => {
      // Closed by the browser mid-exit: the pending close must not hit a sheet opened again.
      this.leaving?.();
      this.leaving = undefined;
      dialog.classList.remove(OUT);
      // Opened again before this event came: the new views stay.
      if (!dialog.open) this.clear();
    });
    // A tap on the backdrop (the dialog itself, outside its content) closes.
    dialog.addEventListener('click', event => { if (event.target === dialog) this.close(); });
    // iOS Safari applies :active (the rows' and switches' press state) only under a touchstart listener.
    dialog.addEventListener('touchstart', () => undefined, { passive: true });
  }

  /** Open and not on its way out. */
  get isOpen(): boolean { return this.dialog.open && !this.leaving; }

  /** Opens the sheet on `view`, replacing whatever it showed. */
  open(view: View): void {
    // A sheet still leaving turns around from where it is.
    this.leaving?.();
    this.leaving = undefined;
    this.clear();
    this.add(view);
    this.show();
    if (!this.dialog.open) showDialog(this.dialog);
  }

  /** Shows `view` on top of the current level. */
  push(view: View): void {
    this.add(view);
    this.show('push');
  }

  /** Re-titles the top level (an agent's chat once it is known to have ended, and so on). */
  retitle(): void { this.show(); }

  /** Closes after the exit; the views are disposed once the dialog has closed. */
  close(): void {
    if (!this.dialog.open) this.clear();
    else this.leaving ??= closeDialog(this.dialog);
  }

  private add(view: View): void {
    const body = el('div', 'sheet-level');
    this.stack.push({ view, body });
    view.render(body);
  }

  private popTo(depth: number): void {
    while (this.stack.length > depth + 1) this.stack.pop()?.view.dispose?.();
    this.show('pop');
  }

  private clear(): void {
    for (const level of this.stack.reverse()) level.view.dispose?.();
    this.stack = [];
    this.body.replaceChildren();
    this.crumbs.replaceChildren();
  }

  /** Draws the top level; `motion` slides it in when it is a new level or one gone back to. */
  private show(motion?: 'push' | 'pop'): void {
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
    // The same level (a retitle) stays put: re-inserting it would replay its animations and lose its scroll.
    if (this.body.firstElementChild === top.body && this.body.childElementCount === 1) return;
    top.body.classList.remove('level-push', 'level-pop');
    if (motion) playOnce(top.body, `level-${motion}`);
    this.body.replaceChildren(top.body);
    this.body.scrollTop = 0;
  }
}

// ------------------------------------------------------------------ rows

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

/** The delay between staggered rows, and how many steps it takes at most, so a long list is not slow to arrive. */
const STAGGER_MS = 35;
const STAGGER_STEPS = 8;

/**
 * Fills `list` with `rows`; `onPick` gets the tapped row's key. `enter` staggers the rows in, from the `top` row or the
 * `bottom` one (a list shown scrolled to its end): pass it only for the first rows a level shows after loading, not on
 * the redraws after.
 */
export function renderRows(list: HTMLElement, rows: readonly Row[], onPick: (key: string) => void, enter?: 'top' | 'bottom'): void {
  list.removeAttribute('aria-busy');
  list.replaceChildren(...rows.map((row, index) => {
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
    if (enter) {
      const step = Math.min(enter === 'top' ? index : rows.length - 1 - index, STAGGER_STEPS);
      li.style.animationDelay = `${step * STAGGER_MS}ms`;
      playOnce(li, 'row-enter');
    }
    return li;
  }));
}

// ------------------------------------------------------------------ loading

// The loading rule, the same in every panel. A panel with something cached shows it at once and refreshes it in the
// background. Otherwise it puts a skeleton in the place of what is coming, but the skeleton stays invisible (keeping
// its room, so nothing jumps) for its first 200ms: an answer that comes by then replaces it unseen, and a quick load
// never flashes one. Past 1.5s a short line says it is still loading. Content that replaces a skeleton fades in
// (`fadeIn`, or `renderRows` with `enter`). The delays are CSS (styles.css, dialogs: `.skeleton-wait` and
// `.skeleton-slow`), so they need no timers and end with the skeleton.

/** The class that holds a skeleton invisible for the loading rule's first moments, then fades it in. */
export const SKELETON_WAIT = 'skeleton-wait';

/** The loading rule's line for a long wait, hidden until 1.5s in; it goes with the skeleton it is placed in. */
export function slowNote(tag: 'p' | 'li' = 'p'): HTMLElement {
  const note = el(tag, 'skeleton-slow', 'Still loading…');
  // Screen readers already have the skeleton's own "Loading…".
  note.setAttribute('aria-hidden', 'true');
  return note;
}

/** Line widths for placeholders, varied so they read as text rather than as bars. */
const WIDTHS = ['72%', '54%', '86%', '63%', '45%', '78%'];

function line(width: string): HTMLElement {
  const node = el('span', 'skeleton skeleton-line');
  node.style.width = width;
  return node;
}

/**
 * Fills `list` with `count` placeholder rows shaped as the rows to come, until `renderRows` replaces them. They follow
 * the loading rule: unseen at first, then a skeleton, then a line saying it is still loading.
 */
export function skeletonRows(list: HTMLElement, count: number, shape: { readonly mark?: boolean; readonly detail?: boolean } = {}): void {
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(...Array.from({ length: count }, (_, index) => {
    const li = el('li', SKELETON_WAIT);
    li.setAttribute('aria-hidden', 'true');
    const row = el('div', 'row row-skeleton');
    if (shape.mark) row.append(el('span', 'row-mark skeleton'));
    const text = el('span', 'row-text');
    text.append(line(WIDTHS[index % WIDTHS.length] ?? '60%'));
    if (shape.detail) text.append(line(WIDTHS[(index + 3) % WIDTHS.length] ?? '40%'));
    row.append(text, el('span', 'row-aside skeleton skeleton-line'));
    li.append(row);
    return li;
  }), slowNote('li'), el('li', 'sr-only', 'Loading…'));
}

/** `count` placeholder lines of text, for a message or a conversation on its way, under the loading rule. */
export function skeletonLines(count: number): HTMLElement {
  const box = el('div', 'skeleton-lines');
  box.setAttribute('aria-busy', 'true');
  const lines = Array.from({ length: count }, (_, index) => line(index === count - 1 ? '38%' : WIDTHS[index % WIDTHS.length] ?? '60%'));
  for (const node of lines) {
    node.setAttribute('aria-hidden', 'true');
    node.classList.add(SKELETON_WAIT);
  }
  box.append(...lines, slowNote(), el('span', 'sr-only', 'Loading…'));
  return box;
}
