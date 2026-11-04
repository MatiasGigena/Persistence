// Waiting in tests: poll a condition instead of sleeping a fixed time, so a loaded machine only makes a test slower,
// and every timeout fails the same way, naming what was awaited.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export interface UntilOptions {
  /** How long to wait before failing; default 5 s. */
  readonly ms?: number;
  /** What to wait between checks; default 20 ms. */
  readonly wait?: () => Promise<unknown>;
}

/** Resolves once `check` holds; fails after `ms`, naming `what` (a function is called then, to describe the state). */
export async function until(check: () => boolean, what: string | (() => string), { ms = 5_000, wait = () => delay(20) }: UntilOptions = {}): Promise<void> {
  for (const end = Date.now() + ms; !check(); await wait()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
  }
}

/**
 * A TUI handles input synchronously but draws on a later tick: resolves once `terminal` has output past `mark`, so the
 * frame after the input is drawn (and a check that nothing happened is not made too early).
 */
export const drawn = (terminal: { readonly output: string }, mark: number): Promise<void> =>
  until(() => terminal.output.length > mark, 'a frame after the input');
