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

/** The tool whose images show in the chat, not folded away (ADR 0031). */
const SHOW_IMAGE = 'show_image';

/** The full-screen image viewer (index.html #viewer): a tap on any chat image opens it, a tap anywhere closes it. */
let viewer: { readonly dialog: HTMLDialogElement; readonly image: HTMLImageElement } | undefined;

/** Wires the viewer up; call once at start. */
export function initViewer(): void {
  const dialog = document.getElementById('viewer'), image = document.getElementById('viewer-image');
  if (!(dialog instanceof HTMLDialogElement) || !(image instanceof HTMLImageElement)) return;
  viewer = { dialog, image };
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { image.removeAttribute('src'); });
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
    img.src = url;
    button.append(img);
    button.addEventListener('click', () => {
      if (!viewer) return;
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

  /** The items to show; drawn on the next animation frame. */
  set(items: readonly ViewItem[]): void {
    this.items = items;
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
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
    const live = new Set<string>();
    let at: ChildNode | null = this.list.firstChild;
    if (at === this.emptyNote) at = at.nextSibling;
    for (const item of this.items) {
      live.add(item.id);
      let entry = this.entries.get(item.id);
      if (!entry || entry.item.kind !== item.kind) {
        entry?.element.remove();
        entry = { element: create(item), item };
        this.entries.set(item.id, entry);
        update(entry.element, item, undefined);
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
    const ends = turnEnds(this.items);
    for (const [id, entry] of this.entries) {
      const actions = entry.item.kind === 'assistant' ? entry.element.querySelector<HTMLElement>('.turn-actions') : null;
      if (actions) actions.hidden = !ends.has(id);
    }
    if (this.items.length) this.emptyNote.remove();
    else this.list.prepend(this.emptyNote);
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
