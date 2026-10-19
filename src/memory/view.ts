// The view (recipe §3): tree nodes tiling messages [0, T), oldest first. Lines are only appended and merged.

/** A tree node: level `l` (it covers 2^l messages) and index `i` at that level. */
export type Pos = { l: number; i: number };

export const start = (p: Pos): number => p.i * 2 ** p.l;
export const end = (p: Pos): number => (p.i + 1) * 2 ** p.l;
export const key = (p: Pos): string => `${p.l}/${p.i}`;
export const parentOf = (p: Pos): Pos => ({ l: p.l + 1, i: Math.floor(p.i / 2) });
export const name = (p: Pos): string => `${start(p)}+${2 ** p.l}`;

export type ViewOptions = { hi: number; lo: number; sizeOf: (p: Pos) => number; built: (p: Pos) => boolean };

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
   * The batch waits for the most due pair's parent rather than merge a less due pair in its place (pi-endless
   * deviation #9); past twice `hi` it falls back to the most due pair whose parent is built. Returns whether it merged.
   */
  fit(T: number): boolean {
    let size = this.bytes;
    if (!this.shrinking && size > this.hi) this.shrinking = true;
    let merged = false;
    while (this.shrinking && size > this.lo) {
      let j = this.mostDue(T, false);
      const first = this.parts[j];
      if (first && !this.built(parentOf(first))) j = size > 2 * this.hi ? this.mostDue(T, true) : -1;
      const a = this.parts[j], b = this.parts[j + 1];
      if (!a || !b) break;
      const parent = parentOf(a);
      size += this.sizeOf(parent) - this.sizeOf(a) - this.sizeOf(b);
      this.parts.splice(j, 2, parent);
      merged = true;
    }
    if (size <= this.lo) this.shrinking = false;
    return merged;
  }

  mostDue(T: number, onlyBuilt: boolean): number {
    let best = -1, bestDue = -Infinity;
    for (let j = 0; j + 1 < this.parts.length; j++) {
      const a = this.parts[j], b = this.parts[j + 1];
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
