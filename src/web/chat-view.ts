// Renders a feed into a list: one element per item, kept by id, so an update touches only its own element. Changes
// are drawn at most once per animation frame, and the list sticks to the bottom while the reader is there.
import { imageUrl } from './attach.ts';
import { addCodeCopies, copyButton } from './copy.ts';
import { prettyArgs, toolCommand, toolSummary } from './format.ts';
import { renderMarkdown } from './markdown.ts';
import { turnEnds } from './store.ts';
import type { ViewItem } from './store.ts';
import type { ChatImage } from '../protocol/messages.ts';

type ToolItem = Extract<ViewItem, { kind: 'tool' }>;

/** How close to the bottom (px) still counts as at the bottom. */
const STICK = 48;
/** More new items than this in one draw is a load (history, a resync), not something arriving: no entrances. */
const BULK = 6;
/** The delay between the entrances of items that arrive together, and the most steps it takes. */
const STAGGER_MS = 40;
const STAGGER_STEPS = 4;

interface Entry {
  readonly element: HTMLLIElement;
  item: ViewItem;
}

/** Creates an element with classes and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * Plays a one-shot animation class (styles.css: .enter, .enter-pop, .fade-in, ...) on `element`, after `delay` ms.
 * The class comes off when the animation ends, so moving the element in the DOM later does not play it again.
 */
export function play(element: HTMLElement, className: string, delay = 0): void {
  element.classList.add(className);
  if (delay) element.style.animationDelay = `${delay}ms`;
  const end = (event: Event): void => {
    // Animations of children (a fold opening, a streaming dot) bubble up here too.
    if (event.target !== element || (event instanceof AnimationEvent && event.pseudoElement)) return;
    element.removeEventListener('animationend', end);
    element.removeEventListener('animationcancel', end);
    element.classList.remove(className);
    element.style.removeProperty('animation-delay');
  };
  element.addEventListener('animationend', end);
  element.addEventListener('animationcancel', end);
}

/** The tool whose images show in the chat, not folded away (ADR 0031). */
const SHOW_IMAGE = 'show_image';

/** The full-screen image viewer (index.html #viewer): a tap on any chat image opens it, a tap anywhere closes it. */
let viewer: { readonly dialog: HTMLDialogElement; readonly image: HTMLImageElement } | undefined;

/** Wires the viewer up; call once at start. */
export function initViewer(): void {
  const dialog = document.getElementById('viewer'), image = document.getElementById('viewer-image');
  if (!(dialog instanceof HTMLDialogElement) || !(image instanceof HTMLImageElement)) return;
  viewer = { dialog, image };
  dialog.addEventListener('click', () => closeViewer(dialog));
  // Escape, or Android's back: the same quick fade out as a tap. Where the browser does not let the cancel be held
  // (no recent user activation), the dialog just closes.
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(dialog); });
  dialog.addEventListener('close', () => {
    dialog.classList.remove('is-closing');
    image.removeAttribute('src');
  });
}

/** Closes the viewer after its exit animation (styles.css .viewer.is-closing), quicker than its entrance. */
function closeViewer(dialog: HTMLDialogElement): void {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  dialog.classList.add('is-closing');
  // getAnimations flushes styles, so the exit is among them; a cancelled one settles too, and an endless one is not
  // waited for. No animations (an old browser): it closes at once.
  const exits = dialog.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
  void Promise.allSettled(exits.map(animation => animation.finished)).then(() => {
    if (dialog.classList.contains('is-closing')) dialog.close();
  });
}

/** Thumbnails of `images`, each a button that opens it full size; one without data is a placeholder. */
function imageStrip(images: readonly ChatImage[], label: string): HTMLElement {
  const strip = el('div', 'images');
  images.forEach((image, k) => {
    const url = imageUrl(image);
    const name = images.length > 1 ? `${label} ${k + 1}` : label;
    if (!url) {
      strip.append(el('span', 'image-missing', `${name}: too large to show here`));
      return;
    }
    const button = el('button', 'image-open');
    button.type = 'button';
    button.setAttribute('aria-label', `Enlarge ${name.toLowerCase()}`);
    const img = el('img', 'image-thumb');
    img.alt = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    // The thumbnail (frame and all) fades in once its picture is there, never as an empty box first; a broken
    // one shows too, with its alt text.
    const loaded = (): void => button.classList.add('is-loaded');
    img.addEventListener('load', loaded, { once: true });
    img.addEventListener('error', loaded, { once: true });
    img.src = url;
    // A picture already decoded (the same image redrawn, as when a sent message reaches the feed) shows at once.
    if (img.complete && img.naturalWidth) loaded();
    button.append(img);
    button.addEventListener('click', () => {
      if (!viewer) return;
      viewer.dialog.classList.remove('is-closing');
      viewer.image.src = url;
      viewer.image.alt = name;
      viewer.dialog.showModal();
    });
    strip.append(button);
  });
  return strip;
}

/** Puts `images` (or none) in `root`'s strip, before `before` when given; redrawn only when the list changed. */
function setImages(root: HTMLElement, images: readonly ChatImage[] | undefined, was: readonly ChatImage[] | undefined,
  label: string, place: (strip: HTMLElement) => void): void {
  const old = root.querySelector(':scope > .images');
  if (old && images === was) return;
  old?.remove();
  if (images?.length) place(imageStrip(images, label));
}

const TOOL_MARK: Readonly<Record<ToolItem['status'], string>> = { running: '', done: '✓', error: '✗' };
const TOOL_STATE: Readonly<Record<ToolItem['status'], string>> = { running: 'running', done: 'done', error: 'failed' };

export interface ChatViewOptions {
  /** Shown while the feed has no items. */
  readonly empty: string;
  /** Called when the reader leaves or reaches the bottom. */
  readonly onStuck?: (stuck: boolean) => void;
}

export class ChatView {
  private readonly list: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly options: ChatViewOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly emptyNote: HTMLElement;
  private items: readonly ViewItem[] = [];
  private frame = 0;
  private stuck = true;
  /** Set once the first draw is done: what that draw shows is the history, never animated in. */
  private drawn = false;
  /** Some `set` since the last draw was not live (a snapshot, a hidden page): the next draw animates nothing. */
  private quiet = false;
  /** Drawing waits for `flush` (a first load shows its whole state at once, never piece by piece). */
  private held = false;
  private readonly resize: ResizeObserver;

  constructor(list: HTMLElement, scroller: HTMLElement, options: ChatViewOptions) {
    this.list = list;
    this.scroller = scroller;
    this.options = options;
    this.emptyNote = el('p', 'empty', options.empty);
    scroller.addEventListener('scroll', () => this.measure(), { passive: true });
    // The keyboard opening, or the composer growing, shrinks the scroller: keep the bottom in view.
    this.resize = new ResizeObserver(() => { if (this.stuck) this.toBottom(); });
    this.resize.observe(scroller);
    this.resize.observe(list);
  }

  /**
   * The items to show; drawn on the next animation frame. `live`: these items arrive while the reader watches, so
   * new ones may enter with an animation; false for a snapshot (a first load, a reconnect), whose items are history.
   */
  set(items: readonly ViewItem[], live = true): void {
    this.items = items;
    // A hidden page draws nothing until it is shown again, and then what came meanwhile is history too.
    if (!live || document.visibilityState !== 'visible') this.quiet = true;
    if (!this.frame && !this.held) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  /**
   * Holds drawing until `flush`. Items `set` meanwhile are kept, and nothing shows, the empty note included: a list
   * not yet loaded is not known to be empty.
   */
  hold(): void {
    this.held = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /**
   * Draws the items now, as history (no entrances), and lifts a hold. Call it with the list in the page, so it lands
   * scrolled to the bottom before it is first seen.
   */
  flush(): void {
    this.held = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.quiet = true;
    this.draw();
  }

  /** Scrolls to the newest item and sticks there. */
  toBottom(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.setStuck(true);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
  }

  private measure(): void {
    const { scrollHeight, scrollTop, clientHeight } = this.scroller;
    this.setStuck(scrollHeight - scrollTop - clientHeight < STICK);
  }

  private setStuck(stuck: boolean): void {
    if (stuck === this.stuck) return;
    this.stuck = stuck;
    this.options.onStuck?.(stuck);
  }

  private draw(): void {
    const live = new Set(this.items.map(item => item.id));
    const before = this.entries.size;
    // A sent message that reaches the feed replaces its pending bubble: it brightens in place rather than entering.
    const settled = new Set<string>();
    for (const [id, entry] of this.entries) if (entry.item.kind === 'pending' && !live.has(id)) settled.add(entry.item.text);
    const fresh: HTMLLIElement[] = [];
    let at: ChildNode | null = this.list.firstChild;
    if (at === this.emptyNote) at = at.nextSibling;
    for (const item of this.items) {
      let entry = this.entries.get(item.id);
      if (!entry || entry.item.kind !== item.kind) {
        const replaced = entry !== undefined;
        entry?.element.remove();
        entry = { element: create(item), item };
        this.entries.set(item.id, entry);
        update(entry.element, item, undefined);
        if (item.kind === 'user' && settled.delete(item.text)) {
          if (this.drawn) play(entry.element, 'is-settling');
        } else if (!replaced) fresh.push(entry.element);
      } else if (entry.item !== item) {
        update(entry.element, item, entry.item);
        entry.item = item;
      }
      // Move only what is out of place; in the usual case (an append at the end) nothing moves.
      if (entry.element !== at) this.list.insertBefore(entry.element, at);
      else at = at.nextSibling;
    }
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      this.entries.delete(id);
    }
    // Entrances only for items arriving while the reader watches: not the first draw, not a quiet one, not a load
    // (many at once, or several into an empty list). Items that arrive together follow each other closely.
    const animate = this.drawn && !this.quiet && fresh.length <= BULK && (before > 0 || fresh.length === 1);
    if (animate) fresh.forEach((element, k) => play(element, 'enter', Math.min(k, STAGGER_STEPS) * STAGGER_MS));
    const ends = turnEnds(this.items);
    for (const [id, entry] of this.entries) {
      const actions = entry.item.kind === 'assistant' ? entry.element.querySelector<HTMLElement>('.turn-actions') : null;
      if (!actions) continue;
      const end = ends.has(id);
      if (end && actions.hidden && animate) play(actions, 'fade-in');
      actions.hidden = !end;
    }
    if (this.items.length) this.emptyNote.remove();
    else this.list.prepend(this.emptyNote);
    this.drawn = true;
    this.quiet = false;
    if (this.stuck) this.toBottom();
  }
}

/** The item a list element shows, kept on it for the handlers that read it later (copy, a tool's toggle). */
const shown = new WeakMap<HTMLElement, ViewItem>();

function create(item: ViewItem): HTMLLIElement {
  const li = el('li', `item item-${item.kind}`);
  switch (item.kind) {
    case 'user': case 'pending':
      li.append(el('div', 'bubble'));
      if (item.kind === 'pending') li.append(el('div', 'meta'));
      break;
    case 'assistant': {
      const actions = el('div', 'turn-actions');
      actions.hidden = true;
      actions.append(copyButton('copy-message', 'Message', () => {
        const now = shown.get(li);
        return now?.kind === 'assistant' ? now.text : '';
      }));
      li.append(el('div', 'prose'), actions);
      break;
    }
    case 'thinking': {
      const details = el('details', 'fold');
      const summary = el('summary');
      summary.append(el('span', 'fold-label', 'Thinking'), el('span', 'fold-preview'));
      details.append(summary, el('div', 'fold-body'));
      li.append(details);
      break;
    }
    case 'tool': {
      const details = el('details', 'fold');
      const summary = el('summary');
      summary.append(el('span', 'tool-mark'), el('span', 'tool-name'), el('span', 'tool-arg'), el('span', 'sr-only tool-state'));
      details.append(summary, el('div', 'fold-body'));
      // Arguments and output are drawn only while open: a long output streaming in costs nothing folded.
      details.addEventListener('toggle', () => { if (details.open) fillTool(details, li); });
      li.append(details);
      break;
    }
    case 'report': {
      const head = el('div', 'report-from');
      li.append(head, el('div', 'prose'));
      break;
    }
    case 'notice':
      li.append(el('span', 'notice-text'));
      break;
  }
  return li;
}

/** A tool's block of text with its copy button; the button reads the item's latest text when tapped. */
function block(li: HTMLLIElement, className: string, label: string, text: string, read: (item: ToolItem) => string): HTMLElement {
  const wrap = el('div', 'code-block');
  const pre = el('pre', className, text);
  // Focusable, so a keyboard can scroll a long line.
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', label);
  wrap.append(pre, copyButton('copy-code', label, () => {
    const now = shown.get(li);
    return now?.kind === 'tool' ? read(now) : text;
  }));
  return wrap;
}

function fillTool(details: HTMLDetailsElement, li: HTMLLIElement): void {
  const item = shown.get(li);
  const body = details.querySelector('.fold-body');
  if (item?.kind !== 'tool' || !body) return;
  const parts: HTMLElement[] = [];
  const command = toolCommand(item.name, item.args);
  const args = prettyArgs(item.args);
  if (command !== undefined) parts.push(block(li, 'tool-command', 'Command', command, now => toolCommand(now.name, now.args) ?? ''));
  else if (args && args !== '{}') parts.push(block(li, 'tool-args', 'Arguments', args, now => prettyArgs(now.args)));
  if (item.output) {
    parts.push(block(li, item.status === 'error' ? 'tool-output is-error' : 'tool-output', 'Output', item.output, now => now.output));
  }
  if (item.images?.length && item.name !== SHOW_IMAGE) parts.push(imageStrip(item.images, 'Image'));
  if (!parts.length) parts.push(el('p', 'fold-empty', item.status === 'running' ? 'Running…' : 'No output.'));
  body.replaceChildren(...parts);
}

const firstLine = (text: string): string => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';

function setText(root: HTMLElement, selector: string, text: string): void {
  const node = root.querySelector(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

/** Brings an element up to `item`; `was` is what it showed before, if anything. */
function update(li: HTMLLIElement, item: ViewItem, was: ViewItem | undefined): void {
  shown.set(li, item);
  switch (item.kind) {
    case 'user':
      setText(li, '.bubble', item.text);
      li.querySelector('.bubble')?.toggleAttribute('hidden', !item.text);
      setImages(li, item.images, was?.kind === 'user' ? was.images : undefined, 'Image', strip => li.prepend(strip));
      break;
    case 'pending':
      setText(li, '.bubble', item.text);
      li.querySelector('.bubble')?.toggleAttribute('hidden', !item.text);
      setImages(li, item.images, was?.kind === 'pending' ? was.images : undefined, 'Image', strip => li.prepend(strip));
      setText(li, '.meta', item.state === 'sending' ? 'Sending…' : item.steer ? 'Steering' : 'Queued');
      break;
    case 'assistant': {
      const prose = li.querySelector('.prose');
      if (prose instanceof HTMLElement && (was?.kind !== 'assistant' || was.text !== item.text)) {
        prose.innerHTML = renderMarkdown(item.text);
        addCodeCopies(prose);
      }
      li.classList.toggle('is-streaming', item.streaming);
      li.hidden = !item.text.trim() && !item.streaming;
      break;
    }
    case 'thinking': {
      setText(li, '.fold-preview', firstLine(item.text));
      setText(li, '.fold-body', item.text.trim());
      li.classList.toggle('is-streaming', item.streaming);
      li.hidden = !item.text.trim();
      break;
    }
    case 'tool': {
      li.dataset.status = item.status;
      setText(li, '.tool-mark', TOOL_MARK[item.status]);
      // A call ending while it is watched: the running dot's cell takes its ✓ or ✗ with a small pop, one mark changing
      // in place rather than a glyph appearing in a frame. Never on history or a resync, which arrive already ended.
      if (was?.kind === 'tool' && was.status === 'running' && item.status !== 'running') {
        const mark = li.querySelector('.tool-mark');
        if (mark instanceof HTMLElement) play(mark, 'mark-pop');
      }
      setText(li, '.tool-name', item.name);
      setText(li, '.tool-arg', toolSummary(item.name, item.args));
      setText(li, '.tool-state', `, ${TOOL_STATE[item.status]}`);
      // show_image's pictures are for the user: in the chat, not folded. Other tools' (a screenshot the model looked
      // at) show in the fold.
      if (item.name === SHOW_IMAGE) {
        setImages(li, item.images, was?.kind === 'tool' ? was.images : undefined, 'Image', strip => li.append(strip));
      }
      const details = li.querySelector('details');
      if (details?.open) fillTool(details, li);
      break;
    }
    case 'report': {
      setText(li, '.report-from', item.from);
      const prose = li.querySelector('.prose');
      if (prose instanceof HTMLElement && (was?.kind !== 'report' || was.text !== item.text)) {
        prose.innerHTML = renderMarkdown(item.text);
        addCodeCopies(prose);
      }
      break;
    }
    case 'notice':
      li.dataset.level = item.level;
      setText(li, '.notice-text', item.text);
      break;
  }
}
