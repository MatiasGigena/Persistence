import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cut, end, start, View } from '../../src/memory/view.ts';
import type { Pos } from '../../src/memory/view.ts';

// Taelin's rollback push (recipe §3.1), the reference for the view's merge order.
type States = { keep: number; life: number; state: number; older: States | null };
function push(s: number, states: States | null): States {
  if (states === null) return { keep: 0, life: 0, state: s, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: s, older: push(state, older) };
}
function pushView(states: States | null, T: number): Pos[] {
  const starts: number[] = [];
  for (let s = states; s; s = s.older) starts.push(s.state);
  starts.reverse();
  return starts.map((st, k) => { const n = (starts[k + 1] ?? T) - st; return { l: Math.log2(n), i: st / n }; });
}

describe('unii view', () => {
  test('due = (T - last) / 2^l with the push list length as budget makes exactly the merges push makes (t = 0..5000)', () => {
    const v = new View({ hi: Infinity, lo: Infinity, sizeOf: () => 1, built: () => true });
    let states: States | null = null;
    for (let t = 0; t <= 5000; t++) {
      states = push(t, states);
      const want = pushView(states, t + 1);
      v.append(t);
      v.hi = v.lo = want.length;
      v.shrinking = true;
      v.fit(t + 1);
      assert.deepEqual(v.parts, want, `t=${t}`);
    }
  });

  test('measuring from the first message instead would not match push (the recipe\'s cautionary example at T=10)', () => {
    // view 0+4, 4+4, 8+1, 9+1 at T=10: push merges 8-9, never the old 0-7
    const v = new View({ hi: 3, lo: 3, sizeOf: () => 1, built: () => true });
    v.parts = [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }];
    v.shrinking = true;
    v.fit(10);
    assert.deepEqual(v.parts, [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 1, i: 4 }]);
  });

  test('sawtooth: between batches the view only grows at its end; few lines rewritten per message', () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const sizes = new Map<string, number>();
    const sizeOf = (p: Pos): number => {
      const k = `${p.l}/${p.i}`;
      let size = sizes.get(k);
      if (size === undefined) sizes.set(k, size = 150 + Math.floor(rnd() * 362));
      return size;
    };
    const v = new View({ hi: 128_000, lo: 64_000, sizeOf, built: () => true });
    let prev: Pos[] = [], resent = 0, batches = 0;
    const N = 5000;
    for (let t = 0; t < N; t++) {
      v.append(t);
      if (v.fit(t + 1)) {
        batches++;
        assert.ok(v.bytes <= 64_000, 'a batch goes down to 64 KB at once');
      } else {
        assert.deepEqual(v.parts.slice(0, prev.length), prev, 'no batch: the old view is a prefix of the new one');
      }
      let k = 0;
      while (k < prev.length && k < v.parts.length && prev[k]?.l === v.parts[k]?.l && prev[k]?.i === v.parts[k]?.i) k++;
      resent += v.parts.length - k;
      prev = v.parts.map(p => ({ ...p }));
      assert.ok(v.tiles(t + 1));
      assert.ok(v.bytes <= 128_000 + 512);
    }
    assert.ok(batches > 5);
    assert.ok(resent / N < 3, `rewrote ${resent / N} lines per message`);
  });

  test('a lagging compactor: the batch waits for the most due pair, the newest lines stay one per message', () => {
    let ready = (p: Pos): boolean => p.l <= 1;
    const v = new View({ hi: 20, lo: 10, sizeOf: () => 1, built: p => ready(p) });
    for (let i = 0; i < 40; i++) { v.append(i); v.fit(i + 1); }
    assert.equal(v.parts.at(-1)?.l, 0);
    assert.equal(v.parts.at(-2)?.l, 0);
    ready = () => true;
    v.fit(40);
    assert.ok(v.parts.length <= 10);
    assert.ok(v.tiles(40));
    assert.equal(v.parts.at(-1)?.l, 0);
  });

  test('only built parents merge; the batch resumes as they land', () => {
    const built = new Set();
    const v = new View({ hi: 10, lo: 4, sizeOf: () => 1, built: p => built.has(`${p.l}/${p.i}`) });
    for (let i = 0; i < 12; i++) { v.append(i); v.fit(i + 1); }
    assert.equal(v.parts.length, 12);
    assert.equal(v.shrinking, true);
    for (let i = 0; i < 6; i++) built.add(`1/${i}`);
    v.fit(12);
    assert.deepEqual(v.parts.map(p => p.l), [1, 1, 1, 1, 0, 0, 0, 0]);
    for (let i = 0; i < 3; i++) built.add(`2/${i}`);
    v.fit(12);
    assert.deepEqual(v.parts.map(p => p.l), [2, 2, 1, 0, 0]);
    assert.equal(v.shrinking, true);
    built.add('3/0');
    v.fit(12);
    assert.deepEqual(v.parts.map(p => p.l), [3, 1, 0, 0]);
    assert.equal(v.shrinking, false);
  });

  test('between messages only a whole batch lands; at a message the batch keeps what merged', () => {
    const built = new Set<string>();
    const v = new View({ hi: 10, lo: 4, sizeOf: () => 1, built: p => built.has(`${p.l}/${p.i}`) });
    for (let i = 0; i < 12; i++) { v.append(i); v.fit(i + 1); }
    for (let i = 0; i < 6; i++) built.add(`1/${i}`);
    assert.equal(v.fit(12, false), false, 'a node built: 8 lines is not a whole batch');
    assert.equal(v.parts.length, 12);
    assert.equal(v.shrinking, true);
    for (let i = 0; i < 3; i++) built.add(`2/${i}`);
    built.add('3/0');
    assert.equal(v.fit(12, false), true, 'now it reaches 4 lines at once');
    assert.deepEqual(v.parts.map(p => p.l), [3, 1, 0, 0]);
    assert.equal(v.shrinking, false);
    const w = new View({ hi: 10, lo: 4, sizeOf: () => 1, built: p => p.l === 1 });
    for (let i = 0; i < 12; i++) { w.append(i); w.fit(i + 1, false); }
    assert.equal(w.parts.length, 12, 'partial merges between messages are held back');
    w.append(12);
    assert.equal(w.fit(13, true), true);
    assert.ok(w.parts.length < 13 && w.tiles(13) && w.shrinking, 'a message takes the partial batch');
  });

  test('past twice the budget it takes what is built (a node that keeps failing)', () => {
    const v = new View({ hi: 4, lo: 2, sizeOf: () => 1, built: p => !(p.l === 1 && p.i === 0) });
    for (let i = 0; i < 9; i++) { v.append(i); v.fit(i + 1); }
    assert.ok(v.parts.length <= 8);
    assert.ok(v.tiles(9));
  });

  test('cut opens a line straddling k into its children', () => {
    const parts = [{ l: 3, i: 0 }, { l: 1, i: 4 }, { l: 0, i: 10 }];
    assert.deepEqual(cut(parts, 11), parts);
    assert.deepEqual(cut(parts, 10), parts.slice(0, 2));
    assert.deepEqual(cut(parts, 5).map(p => `${start(p)}-${end(p)}`), ['0-4', '4-5']);
  });
});
