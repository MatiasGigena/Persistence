// The images attached to the next message (ADR 0031): thumbnails over the composer, each with a remove button, and a
// spinner tile while files are read. It owns that state; the composer asks it what is attached and takes it on send.
import { imageUrl, toChatImage } from './attach.ts';
import { el, play } from './chat-view.ts';
import { inOrder } from './format.ts';
import { IMAGE_LIMITS, restoreImages } from '../protocol/images.ts';
import type { NoticeLevel } from '../protocol/session.ts';
import type { ChatImage } from '../protocol/images.ts';
import { errorMessage } from '../protocol/util.ts';

/**
 * Makes `nodes` the children of `parent`, in order, moving only what is out of place: a node that stays is never
 * taken out and put back, which would restart its animations (a spinner, an entrance).
 */
function place(parent: HTMLElement, nodes: readonly Node[]): void {
  let at = parent.firstChild;
  for (const node of nodes) {
    if (node === at) at = at.nextSibling;
    else parent.insertBefore(node, at);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}

interface Tile { readonly li: HTMLLIElement; readonly img: HTMLImageElement; readonly remove: HTMLButtonElement }

export interface TrayOptions {
  /** Says what could not be attached. */
  readonly notice: (text: string, level: NoticeLevel) => void;
  /** After every change: the send button depends on what is attached and read. */
  readonly onChange: () => void;
  /** After a remove button: the composer takes the focus back. */
  readonly onRemove: () => void;
}

export class AttachmentTray {
  private readonly list: HTMLUListElement;
  private readonly options: TrayOptions;
  private attached: ChatImage[] = [];
  /** Images being read or scaled: the send waits for them. */
  private pending = 0;
  /** Each attached image's tile, kept while it stays attached: a redraw moves tiles, so only a new one pops in. */
  private readonly tiles = new Map<ChatImage, Tile>();
  /** The tile shown while images are read: the shape of the one coming, with a spinner. */
  private readonly readingTile = el('li', 'attachment attachment-reading skeleton');
  /** The images being read, in the order they were added: each joins `attached` in that order. */
  private readQueue: Promise<void> = Promise.resolve();

  constructor(list: HTMLUListElement, options: TrayOptions) {
    this.list = list;
    this.options = options;
    this.readingTile.append(el('span', 'spinner'), el('span', 'sr-only', 'Reading image…'));
  }

  /** The images attached now, in order. */
  get images(): readonly ChatImage[] { return this.attached; }
  /** How many images are still being read. */
  get reading(): number { return this.pending; }

  /** The attached images, leaving the tray empty: the send took them. */
  take(): ChatImage[] {
    const taken = this.attached;
    this.attached = [];
    this.draw();
    return taken;
  }

  /** Puts a failed send's images back, after any attached meanwhile; resolves with how many did not fit. */
  restore(images: readonly ChatImage[]): number {
    if (!images.length) return 0;
    const restored = restoreImages(this.attached, images, Math.max(0, IMAGE_LIMITS.perMessage - this.pending));
    this.attached = restored.images;
    this.draw();
    return restored.dropped;
  }

  /** Reads `files` and attaches them in order, as many as fit in one message; the rest are refused with a notice. */
  attach(files: readonly File[]): void {
    const room = IMAGE_LIMITS.perMessage - this.attached.length - this.pending;
    if (files.length > room) this.options.notice(`At most ${IMAGE_LIMITS.perMessage} images per message.`, 'warn');
    const batch = files.slice(0, Math.max(0, room));
    if (!batch.length) return;
    this.pending += batch.length;
    this.draw();
    this.readQueue = inOrder(batch, toChatImage, result => {
      if (result.ok) this.attached = [...this.attached, result.value];
      else this.options.notice(`Image not attached: ${errorMessage(result.error)}`, 'error');
      this.pending--;
      this.draw();
    }, this.readQueue);
  }

  private draw(): void {
    this.list.hidden = !this.attached.length && !this.pending;
    for (const image of this.tiles.keys()) if (!this.attached.includes(image)) this.tiles.delete(image);
    const nodes: Node[] = this.attached.map((image, k) => this.tile(image, k));
    if (this.pending) nodes.push(this.readingTile);
    place(this.list, nodes);
    this.options.onChange();
  }

  /** `image`'s tile, labelled as the `k`th image. */
  private tile(image: ChatImage, k: number): HTMLLIElement {
    const known = this.tiles.get(image) ?? this.newTile(image);
    known.img.alt = `Image ${k + 1}`;
    known.remove.setAttribute('aria-label', `Remove image ${k + 1}`);
    return known.li;
  }

  private newTile(image: ChatImage): Tile {
    const li = el('li', 'attachment');
    const img = el('img', 'attachment-image');
    img.src = imageUrl(image) ?? '';
    const remove = el('button', 'attachment-remove');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    remove.addEventListener('click', () => {
      this.attached = this.attached.filter(each => each !== image);
      this.draw();
      this.options.onRemove();
    });
    li.append(img, remove);
    play(li, 'enter-pop');
    const made = { li, img, remove };
    this.tiles.set(image, made);
    return made;
  }
}
