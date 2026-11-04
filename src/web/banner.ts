// The line under the header that says the link is down, reconnecting or slow, with a retry button. It stays in the
// page and comes and goes by class, as a CSS transition: a quick toggle turns around mid-way instead of restarting.

export class Banner {
  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;

  constructor(root: HTMLElement, text: HTMLElement, retry: HTMLButtonElement, onRetry: () => void) {
    this.root = root;
    this.text = text;
    this.retry = retry;
    root.hidden = false;
    retry.addEventListener('click', onRetry);
  }

  /** A line is showing now. */
  get shown(): boolean { return this.visible; }

  /** `text` is the line showing now. */
  shows(text: string): boolean { return this.visible && this.text.textContent === text; }

  /** Shows `text` (with the retry button if `canRetry`), or hides the banner for ''; cancels a line still waiting. */
  set(text: string, canRetry: boolean): void {
    clearTimeout(this.timer);
    this.visible = Boolean(text);
    this.root.classList.toggle('is-shown', this.visible);
    // Hiding keeps the last text and button, so the banner does not empty out while it slides away.
    if (!text) return;
    this.text.textContent = text;
    this.retry.hidden = !canRetry;
  }

  /** Shows `text` after `delayMs`, unless another line or a hide comes first. */
  later(text: string, canRetry: boolean, delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.set(text, canRetry), delayMs);
  }
}
