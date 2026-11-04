// The view (recipe §3): tree nodes tiling messages [0, T), oldest first. Lines are only appended and merged.

/** A tree node: level `l` (it covers 2^l messages) and index `i` at that level. */
export interface Pos { l: number; i: number }

export const start = (p: Pos): number => p.i * 2 ** p.l;
export const end = (p: Pos): number => (p.i + 1) * 2 ** p.l;
export const key = (p: Pos): string => `${p.l}/${p.i}`;
export const parentOf = (p: Pos): Pos => ({ l: p.l + 1, i: Math.floor(p.i / 2) });
export const name = (p: Pos): string => `${start(p)}+${2 ** p.l}`;

export interface ViewOptions { hi: number; lo: number; sizeOf: (p: Pos) => number; built: (p: Pos) => boolean }

export class View {
  hi: number;
  lo: number;
  sizeOf: (p: Pos) => number;
  built: (p: Pos) => boolean;
  parts: Pos[] = [];
  shrinking = false; // a batch is under way: from past `hi` until at most `lo`

  /** `sizeOf(p)`: bytes the line costs; `built(p)`: whether node p exists. */
  constructor({ hi, lo, sizeOf, built }: ViewOptions) {
    this.hi = hi;
    this.lo = lo;
    this.sizeOf = sizeOf;
    this.built = built;
  }

  get bytes(): number { return this.parts.reduce((sum, p) => sum + this.sizeOf(p), 0); }

  append(i: number): void { this.parts.push({ l: 0, i }); }

  /**
   * Sawtooth batch: past `hi`, merge the most due pairs until at most `lo`. due = (T - last) / 2^l, oldest on ties.
   * The batch waits for the most due pair's parent rather than merge a less due pair in its place; past twice `hi` it
   * falls back to the most due pair whose parent is built. At a message (`atMessage`) the view keeps what merged;
   * between messages (a node built) only a whole batch, down to `lo` or by at least `hi`, so the view changes once per
   * batch and otherwise only at messages (adapted from UniiChat Memory.ts `fit`, Apache-2.0). Returns whether it merged.
   */
  fit(T: number, atMessage = true): boolean {
    const before = this.bytes;
    if (!this.shrinking && before > this.hi) this.shrinking = true;
    if (!this.shrinking) return false;
    const parts = [...this.parts];
    let size = before;
    while (size > this.lo) {
      let j = this.mostDue(parts, T, false);
      const first = parts[j];
      if (first && !this.built(parentOf(first))) j = size > 2 * this.hi ? this.mostDue(parts, T, true) : -1;
      const a = parts[j], b = parts[j + 1];
      if (!a || !b) break;
      const parent = parentOf(a);
      size += this.sizeOf(parent) - this.sizeOf(a) - this.sizeOf(b);
      parts.splice(j, 2, parent);
    }
    const whole = size <= this.lo, merged = parts.length < this.parts.length;
    if (merged && !atMessage && !whole && size > before - this.hi) return false;
    if (merged) this.parts = parts;
    if (whole) this.shrinking = false;
    return merged;
  }

  mostDue(parts: readonly Pos[], T: number, onlyBuilt: boolean): number {
    let best = -1, bestDue = -Infinity;
    for (let j = 0; j + 1 < parts.length; j++) {
      const a = parts[j], b = parts[j + 1];
      if (!a || !b || a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      if (onlyBuilt && !this.built(parentOf(a))) continue;
      const due = (T - (end(b) - 1)) / 2 ** a.l; // exact: division by a power of two
      if (due > bestDue) { best = j; bestDue = due; }
    }
    return best;
  }

  tiles(T: number): boolean {
    let at = 0;
    for (const p of this.parts) { if (start(p) !== at) return false; at = end(p); }
    return at === T;
  }
}

/** Lines cut back to messages [0, k): later lines go, a line straddling k opens into its children. */
export function cut(parts: readonly Pos[], k: number): Pos[] {
  const out: Pos[] = [];
  const add = (p: Pos): void => {
    if (start(p) >= k) return;
    if (end(p) <= k) out.push(p);
    else for (const i of [2 * p.i, 2 * p.i + 1]) add({ l: p.l - 1, i });
  };
  for (const p of parts) add(p);
  return out;
}
