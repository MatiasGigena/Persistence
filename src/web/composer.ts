// The composer (ADR 0031 for its images): the message box, its draft kept across reloads, the attachment tray, and the
// one button that sends, steers while Pi works, and stops Pi while the box is empty. Sends go through an Outbox, so a
// reconnect resends each with its request id and Pi gets it once.
import type { ChatView } from './chat-view.ts';
import type { Link } from './link.ts';
import { Outbox } from './outbox.ts';
import { load, local, save } from './storage.ts';
import type { Store } from './store.ts';
import { AttachmentTray } from './tray.ts';
import { IMAGE_LIMITS } from '../protocol/images.ts';
import type { ChatImage } from '../protocol/images.ts';
import { RequestError } from '../protocol/request-error.ts';
import type { NoticeLevel } from '../protocol/session.ts';
import { errorMessage } from '../protocol/util.ts';

export const DRAFT_KEY = 'pd.draft';
/** After a send the button cannot turn into stop for this long: a double tap must not withdraw what was just sent. */
const SEND_HUSH_MS = 600;

/** A short tap of haptic feedback, where the browser has it. */
function buzz(): void {
  if (!('vibrate' in navigator)) return;
  try { navigator.vibrate(8); } catch { /* feedback only */ }
}

/** The composer's elements. */
export interface ComposerElements {
  readonly form: HTMLFormElement;
  readonly input: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  readonly attach: HTMLButtonElement;
  readonly attachFile: HTMLInputElement;
  readonly attachments: HTMLUListElement;
}

/** What the composer needs from the page. */
export interface ComposerDeps {
  readonly link: Link;
  readonly store: Store;
  readonly view: ChatView;
  readonly notice: (text: string, level?: NoticeLevel) => void;
  /** The first load is shown: before it there is nothing to send into, and the draft waits. */
  readonly loaded: () => boolean;
  /** The link is ready: only then is the session's busy flag current. */
  readonly linkReady: () => boolean;
}

export class Composer {
  private readonly els: ComposerElements;
  private readonly deps: ComposerDeps;
  private readonly outbox = new Outbox();
  private readonly tray: AttachmentTray;
  /** An abort is in flight: the stop button is disabled until it settles or Pi goes idle, so it is sent once. */
  private stopping = false;
  /** Set for SEND_HUSH_MS after a send. */
  private hush: ReturnType<typeof setTimeout> | undefined;

  constructor(els: ComposerElements, deps: ComposerDeps) {
    this.els = els;
    this.deps = deps;
    const { input, form, attach, attachFile } = els;
    this.tray = new AttachmentTray(els.attachments, { notice: deps.notice, onChange: () => this.draw(), onRemove: () => input.focus() });
    attach.addEventListener('click', () => attachFile.click());
    attachFile.addEventListener('change', () => {
      this.tray.attach([...attachFile.files ?? []]);
      attachFile.value = '';
    });
    // A pasted screenshot (or copied image file): attached, not pasted as text.
    input.addEventListener('paste', event => {
      const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      this.tray.attach(files);
    });
    form.addEventListener('dragover', event => {
      if ([...event.dataTransfer?.items ?? []].some(item => item.kind === 'file')) event.preventDefault();
    });
    form.addEventListener('drop', event => {
      const files = [...event.dataTransfer?.files ?? []].filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      this.tray.attach(files);
    });
    input.value = load(local, DRAFT_KEY);
    this.autosize();
    input.addEventListener('input', () => { this.autosize(); this.saveDraft(); });
    // Enter sends only with a keyboard and mouse; on a phone, Enter is a new line and the button sends.
    const finePointer = matchMedia('(pointer: fine)');
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !finePointer.matches) return;
      event.preventDefault();
      // Enter only sends: stopping Pi takes the button (or Esc in the terminal), never a stray keypress.
      if ((input.value.trim() || this.tray.images.length) && !this.tray.reading) this.submit();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const stopTap = els.send.dataset.mode === 'stop';
      this.submit();
      // A tap on stop must not raise the keyboard.
      if (!stopTap) input.focus();
    });
  }

  /**
   * Draws the one button: send, steer while Pi works, and stop while Pi works and the box is empty. Stop never shows
   * while a send is unadmitted or just after one, and the busy flag counts only while the link is ready (it is stale
   * otherwise); in those cases the button is a disabled send.
   */
  draw(): void {
    const { input, send } = this.els;
    const busy = this.busy();
    if (!busy) this.stopping = false;
    const typed = Boolean(input.value.trim()) || this.tray.images.length > 0;
    const working = this.deps.linkReady() && busy;
    const held = this.outbox.size > 0 || this.hush !== undefined;
    const mode = typed ? (working ? 'steer' : 'send') : working && !held ? 'stop' : 'send';
    send.dataset.mode = mode;
    send.disabled = mode === 'stop' ? this.stopping : !typed || this.tray.reading > 0 || !this.deps.loaded();
    const label = mode === 'stop' ? 'Stop Pi' : mode === 'steer' ? 'Steer Pi' : 'Send';
    send.setAttribute('aria-label', label);
    send.title = label;
    input.placeholder = busy ? 'Steer Pi…' : 'Message Pi';
  }

  /** Fits the box to its text, then redraws the button. */
  autosize(): void {
    const { input } = this.els;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    this.draw();
  }

  /** Sends again every send not yet admitted, with its request id: after a reconnect. */
  resend(): void {
    for (const [id, { text, steer, images }] of this.outbox.entries()) this.deliver(id, text, steer, images);
  }

  /**
   * Before the page reloads: unadmitted sends go back into the saved draft (only text survives a reload); resolves
   * with how many images, theirs and the draft's, are lost.
   */
  beforeReload(): number {
    const kept = this.outbox.beforeReload(this.els.input.value, this.tray.images.length);
    if (this.outbox.size) save(local, DRAFT_KEY, kept.draft);
    return kept.lostImages;
  }

  /** Pi is working: a message steers it, and the button stops it while the box is empty. */
  private busy(): boolean { return this.deps.store.status?.busy ?? false; }

  private saveDraft(): void { save(local, DRAFT_KEY, this.els.input.value); }

  private abort(): void {
    this.stopping = true;
    buzz();
    this.draw();
    this.deps.link.request('abort', {})
      .catch((error: unknown) => this.deps.notice(`Interrupt failed: ${errorMessage(error)}`, 'error'))
      .finally(() => { this.stopping = false; this.draw(); });
  }

  private submit(): void {
    const { input, send } = this.els;
    if (!this.deps.loaded()) return;
    const text = input.value.trim();
    if (!text && !this.tray.images.length) {
      if (send.dataset.mode === 'stop' && !send.disabled) this.abort();
      return;
    }
    buzz();
    clearTimeout(this.hush);
    this.hush = setTimeout(() => { this.hush = undefined; this.draw(); }, SEND_HUSH_MS);
    const steer = this.busy();
    const images = this.tray.take();
    const id = this.outbox.add({ text, steer, images });
    this.deps.store.addPending(id, text, steer, images);
    input.value = '';
    this.autosize();
    this.saveDraft();
    this.deps.view.toBottom();
    this.deliver(id, text, steer, images);
  }

  private deliver(id: string, text: string, steer: boolean, images: readonly ChatImage[]): void {
    const { link, store, notice } = this.deps;
    link.request('send', { text, requestId: id, ...steer ? { steer } : {}, ...images.length ? { images } : {} }).then(
      () => { this.outbox.delete(id); store.admitPending(id); this.draw(); },
      (error: unknown) => {
        if (error instanceof RequestError && error.code === 'disconnected') return;
        this.outbox.delete(id);
        this.draw();
        store.dropPending(id);
        const { input } = this.els;
        if (!input.value) { input.value = text; this.autosize(); this.saveDraft(); }
        // The images come back too, merged with any attached meanwhile; what does not fit is said, never dropped silently.
        const dropped = this.tray.restore(images);
        notice(`Not sent: ${errorMessage(error)}`, 'error');
        if (dropped) {
          notice(`${dropped} image${dropped === 1 ? '' : 's'} could not go back into the message (at most ${IMAGE_LIMITS.perMessage}); attach ${dropped === 1 ? 'it' : 'them'} again.`, 'warn');
        }
      },
    );
  }
}
