// What a change of the link's state means for the page: the banner line, the pairing or "gone" screens, a reload for a
// new protocol, or the first load's own rule. No DOM, so test/web runs it in Node; main.ts applies the result.
import { LINK_TEXT } from './format.ts';
import type { ClosedBy, LinkState } from './link.ts';
import { CloseCode } from '../protocol/messages.ts';

export const RESTARTING = 'The server is restarting; reconnecting…';
/** A phone that wakes up reconnects in about a second: the reconnecting line waits this long, so that is not shown. */
export const RECONNECT_BANNER_MS = 2_000;

/** What the page knows besides the new state. */
export interface LinkFacts {
  /** The first `ready` has been shown; until then the first load's rule applies. */
  readonly loaded: boolean;
  /** The link was ready just before this change. */
  readonly wasReady: boolean;
  /** The banner is showing a line now. */
  readonly bannerShown: boolean;
  /** The close code the last connection dropped with. */
  readonly droppedWith: number | undefined;
  /** Why the link closed for good, once `closed`. */
  readonly closedBy: ClosedBy | undefined;
  /** The reason of the server's `bye` since the last `ready`. */
  readonly byeReason: string;
}

/** The page's response to a state. `disconnect`: the agent feeds open until now must be reopened at the next ready. */
export type LinkStep = { readonly disconnect: boolean } & (
  | { readonly t: 'hide-banner' }
  | { readonly t: 'loading' }
  | { readonly t: 'banner'; readonly text: string; readonly retry: boolean; readonly delayMs: number }
  | { readonly t: 'pair'; readonly reason: string }
  | { readonly t: 'gone' }
  | { readonly t: 'reload-version' }
  | { readonly t: 'none' }
);

/** The page's response to the link entering `state`. */
export function linkStep(state: LinkState, facts: LinkFacts): LinkStep {
  const disconnect = facts.wasReady && state !== 'ready' && state !== 'closed';
  if (state === 'ready') return { disconnect: false, t: 'hide-banner' };
  if (state !== 'closed' && !facts.loaded) return { disconnect, t: 'loading' };
  // A restart takes longer than a phone waking up: said at once, so a dead-looking chat is explained.
  if (state === 'reconnecting' && facts.droppedWith === CloseCode.restart) return { disconnect, t: 'banner', text: RESTARTING, retry: true, delayMs: 0 };
  if (state === 'reconnecting' || state === 'offline') {
    const { text, retry } = LINK_TEXT[state];
    return { disconnect, t: 'banner', text, retry, delayMs: state === 'reconnecting' && !facts.bannerShown ? RECONNECT_BANNER_MS : 0 };
  }
  if (state !== 'closed') return { disconnect, t: 'none' };
  switch (facts.closedBy) {
    // A revoked device is told so, rather than finding the pairing screen with no reason.
    case 'unauthorized': return { disconnect, t: 'pair', reason: `${facts.byeReason || 'This device is no longer paired.'} Pair it again with a new code.` };
    case 'unpaired': return { disconnect, t: 'pair', reason: '' };
    case 'forbidden': return { disconnect, t: 'gone' };
    case 'version': return { disconnect, t: 'reload-version' };
    default: return { disconnect, t: 'none' };
  }
}
