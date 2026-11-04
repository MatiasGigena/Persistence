// Sends not yet admitted by the server, by request id: each is resent with the same id after a reconnect, so Pi gets it
// once. No DOM, so test/web runs it in Node.
import type { ChatImage } from '../protocol/messages.ts';

export interface Outgoing {
  readonly text: string;
  readonly steer: boolean;
  readonly images: readonly ChatImage[];
}

export class Outbox {
  private readonly prefix: string;
  private counter = 0;
  private readonly sends = new Map<string, Outgoing>();

  /** `prefix` makes this page's request ids its own: a reload starts a new one. */
  constructor(prefix = `web-${Math.random().toString(36).slice(2, 10)}`) { this.prefix = prefix; }

  /** Holds `send` until it is admitted or refused; resolves with its new request id. */
  add(send: Outgoing): string {
    const id = `${this.prefix}-${++this.counter}`;
    this.sends.set(id, send);
    return id;
  }

  /** The send is settled (admitted, or refused and given back): it is not resent. */
  delete(id: string): void { this.sends.delete(id); }

  get size(): number { return this.sends.size; }

  /** Every unsettled send with its id, oldest first: what a reconnect resends. */
  entries(): [string, Outgoing][] { return [...this.sends]; }

  /**
   * What a reload of the page keeps of the unsettled sends: their texts, before `draft`, as one draft; and how many
   * images they and `attached` (the draft's) lose, since only text survives.
   */
  beforeReload(draft: string, attached: number): { readonly draft: string; readonly lostImages: number } {
    const sends = [...this.sends.values()];
    return {
      draft: [...sends.map(send => send.text), draft].filter(Boolean).join('\n\n'),
      lostImages: attached + sends.reduce((sum, send) => sum + send.images.length, 0),
    };
  }
}
