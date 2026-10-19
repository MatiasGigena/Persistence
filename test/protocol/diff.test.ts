import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clip, diffItems, wireItem } from '../../src/protocol/diff.ts';
import { LIMITS } from '../../src/protocol/messages.ts';
import type { ChatItem, ItemOp } from '../../src/protocol/messages.ts';
import { applyOps } from '../../src/protocol/mirror.ts';
import { isParseError, parseServerMessage } from '../../src/protocol/parse.ts';

/** mulberry32: a small seeded PRNG, so a failing sequence can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random items and changes to them, from one seed. */
class Gen {
  private readonly random: () => number;
  private count = 0;
  constructor(seed: number) { this.random = prng(seed); }
  int(n: number): number { return Math.floor(this.random() * n); }
  chance(p: number): boolean { return this.random() < p; }
  pick<T>(values: readonly T[]): T {
    const value = values[this.int(values.length)];
    if (value === undefined) throw new Error('pick from an empty list');
    return value;
  }
  /** Text with multi-unit characters, so appends and clips meet surrogate pairs. */
  text(max = 12): string {
    return Array.from({ length: this.int(max) }, () => this.pick(['a', 'b', ' ', '\n', 'é', '😀', '"', '\\', '{'])).join('');
  }
  item(id = `i${++this.count}`): ChatItem {
    switch (this.int(6)) {
      case 0: return { kind: 'user', id, text: this.text() };
      case 1: return { kind: 'assistant', id, text: this.text(), streaming: this.chance(0.5) };
      case 2: return { kind: 'thinking', id, text: this.text(), streaming: this.chance(0.5) };
      case 3: return { kind: 'tool', id, name: this.pick(['bash', 'read', 'zoom']), args: this.text(), output: this.text(),
        status: this.pick(['running', 'done', 'error'] as const) };
      case 4: return { kind: 'report', id, from: this.pick(['Bob', 'Ada']), text: this.text() };
      default: return { kind: 'notice', id, text: this.text(), level: this.pick(['info', 'warn', 'error'] as const) };
    }
  }
  /** An item changed as a feed changes one: text grows, a flag or status flips, text is replaced, the kind changes. */
  changed(item: ChatItem): ChatItem {
    const way = this.int(4);
    if (way === 3) return this.item(item.id);
    if (item.kind === 'tool') {
      if (way === 0) return { ...item, output: item.output + this.text(), args: this.chance(0.3) ? item.args + this.text() : item.args };
      if (way === 1) return { ...item, status: this.pick(['running', 'done', 'error'] as const), output: item.output + this.text(3) };
      return { ...item, output: this.text() };
    }
    if (way === 0) return { ...item, text: item.text + this.text() };
    if (way === 1 && (item.kind === 'assistant' || item.kind === 'thinking')) return { ...item, streaming: !item.streaming };
    return { ...item, text: this.text() };
  }
  /** `items` after 1 to 4 random changes; now and then one that breaks the order rule. */
  step(items: readonly ChatItem[]): ChatItem[] {
    const list = [...items];
    for (let n = 1 + this.int(4); n > 0; n--) {
      const at = this.int(list.length + 1), current = list[at];
      const roll = this.random();
      if (roll < 0.35 && current) list[at] = this.changed(current);
      else if (roll < 0.6) list.splice(at, 0, this.item());
      else if (roll < 0.75) list.push(this.item());
      else if (roll < 0.9 && current) list.splice(at, 1);
      else if (roll < 0.95 && list.length > 1) {
        const other = this.int(list.length), a = list[at], b = list[other];
        if (a && b) { list[at] = b; list[other] = a; }
      } else if (current) list.push(this.item(current.id));
    }
    return list;
  }
}

/** The order rule, stated independently of diffItems: no repeated id, and shared items in the same relative order. */
function needsSnapshot(prev: readonly ChatItem[], next: readonly ChatItem[]): boolean {
  const p = prev.map(item => item.id), n = next.map(item => item.id);
  if (new Set(p).size !== p.length || new Set(n).size !== n.length) return true;
  return p.filter(id => n.includes(id)).join('\0') !== n.filter(id => p.includes(id)).join('\0');
}

/** The ops after a trip through JSON and the client's parser, as a client gets them. */
function overTheWire(ops: readonly ItemOp[]): readonly ItemOp[] {
  const message = parseServerMessage(JSON.stringify({ t: 'items', feed: 'root', ops }));
  assert.ok(!isParseError(message) && message.t === 'items', JSON.stringify(message));
  return message.ops;
}

describe('diffItems and applyOps', () => {
  test('a mirror follows random feeds through ops, and snapshots only when the order rule needs one', () => {
    let steps = 0, snapshots = 0, appends = 0, inserts = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const gen = new Gen(seed);
      let server: ChatItem[] = Array.from({ length: gen.int(6) }, () => gen.item());
      let mirror: readonly ChatItem[] = server;
      for (let i = 0; i < 40; i++, steps++) {
        const next = gen.step(server);
        const ops = diffItems(server, next);
        const context = `seed ${seed}, step ${i}`;
        assert.equal(ops === 'snapshot', needsSnapshot(server, next), context);
        if (ops === 'snapshot') {
          snapshots++;
          mirror = next;
        } else {
          appends += ops.filter(op => op.op === 'append').length;
          inserts += ops.filter(op => op.op === 'put' && op.before !== undefined).length;
          const applied = applyOps(mirror, overTheWire(ops));
          assert.deepEqual(applied, next, context);
          mirror = applied;
        }
        // A list with a repeated id cannot be diffed again; the server would keep sending snapshots of it.
        server = needsSnapshot([], next) ? next.filter((item, k) => next.findIndex(each => each.id === item.id) === k) : next;
        if (server.length !== next.length) mirror = server;
      }
    }
    assert.ok(snapshots > 100 && snapshots < steps / 4, `${snapshots} snapshots in ${steps} steps`);
    assert.ok(appends > 1000, `${appends} appends`);
    assert.ok(inserts > 1000, `${inserts} inserts before an item`);
  });

  test('unchanged items give no ops, and the same objects stay in the mirror', () => {
    const items: ChatItem[] = [{ kind: 'user', id: 'u', text: 'hi' }, { kind: 'assistant', id: 'a', text: 'yo', streaming: false }];
    assert.deepEqual(diffItems(items, items.map(item => ({ ...item }))), []);
    const applied = applyOps(items, [{ op: 'put', item: { kind: 'user', id: 'n', text: 'new' } }]);
    assert.ok(applied !== 'resync');
    assert.equal(applied[0], items[0]);
    assert.equal(items.length, 2, 'the input list is untouched');
  });

  test('a growing answer is an append; anything else about it is a put', () => {
    const a: ChatItem = { kind: 'assistant', id: 'a', text: 'Hel', streaming: true };
    assert.deepEqual(diffItems([a], [{ ...a, text: 'Hello' }]), [{ op: 'append', id: 'a', field: 'text', at: 3, text: 'lo' }]);
    const done: ChatItem = { ...a, text: 'Hello', streaming: false };
    assert.deepEqual(diffItems([a], [done]), [{ op: 'put', item: done }]);
    const t: ChatItem = { kind: 'tool', id: 't', name: 'bash', args: '{"command":"l', output: '', status: 'running' };
    const grown: ChatItem = { ...t, args: '{"command":"ls"}', output: 'a.txt\n' };
    assert.deepEqual(diffItems([t], [grown]), [
      { op: 'append', id: 't', field: 'args', at: 13, text: 's"}' },
      { op: 'append', id: 't', field: 'output', at: 0, text: 'a.txt\n' },
    ]);
  });

  test('new items go before the next kept item; deletions come first', () => {
    const x: ChatItem = { kind: 'user', id: 'x', text: 'x' }, y: ChatItem = { kind: 'user', id: 'y', text: 'y' };
    const n1: ChatItem = { kind: 'notice', id: 'n1', text: 'retry', level: 'warn' }, n2: ChatItem = { kind: 'user', id: 'n2', text: 'z' };
    assert.deepEqual(diffItems([x, y], [n1, y, n2]), [
      { op: 'del', id: 'x' }, { op: 'put', item: n1, before: 'y' }, { op: 'put', item: n2 },
    ]);
    assert.equal(diffItems([x, y], [y, x]), 'snapshot');
    assert.equal(diffItems([x, x], [x]), 'snapshot');
    assert.equal(diffItems([x], [x, { ...y, id: 'x' }]), 'snapshot');
  });

  test('applyOps asks for a resync when an op does not fit', () => {
    const items: ChatItem[] = [
      { kind: 'assistant', id: 'a', text: 'abc', streaming: true },
      { kind: 'tool', id: 't', name: 'bash', args: '{}', output: 'out', status: 'running' },
    ];
    const bad: ItemOp[][] = [
      [{ op: 'append', id: 'a', field: 'text', at: 2, text: 'd' }],
      [{ op: 'append', id: 'ghost', field: 'text', at: 0, text: 'd' }],
      [{ op: 'append', id: 'a', field: 'output', at: 3, text: 'd' }],
      [{ op: 'append', id: 't', field: 'text', at: 0, text: 'd' }],
      [{ op: 'append', id: 't', field: 'output', at: 4, text: 'd' }],
      [{ op: 'del', id: 'ghost' }],
      [{ op: 'put', item: { kind: 'user', id: 'u', text: 'u' }, before: 'ghost' }],
      [{ op: 'del', id: 'a' }, { op: 'append', id: 'a', field: 'text', at: 3, text: 'd' }],
    ];
    for (const ops of bad) assert.equal(applyOps(items, ops), 'resync', JSON.stringify(ops));
    assert.deepEqual(applyOps(items, [{ op: 'append', id: 't', field: 'output', at: 3, text: '!' }, { op: 'append', id: 'a', field: 'text', at: 3, text: 'd' }]),
      [{ ...items[0], text: 'abcd' }, { ...items[1], output: 'out!' }]);
  });
});

describe('clipping on the wire', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test('clip keeps the head and the tail, says how much it cut, and never splits a pair', () => {
    assert.equal(clip('short'), 'short');
    for (const [text, max] of [['x'.repeat(200), 100], ['😀'.repeat(150), 101], ['a😀'.repeat(70), 100], ['😀'.repeat(40_000), LIMITS.clip]] as const) {
      const out = clip(text, max);
      assert.ok(out.length <= max, `${out.length} > ${max}`);
      assert.doesNotMatch(out, lone);
      const match = /^([^]*)\n… \[(\d+) characters clipped\] …\n([^]*)$/.exec(out);
      assert.ok(match, out.slice(0, 80));
      const [, head = '', cut = '', tail = ''] = match;
      assert.ok(text.startsWith(head) && text.endsWith(tail));
      assert.equal(head.length + Number(cut) + tail.length, text.length);
      // 64 code units are kept for the marker; a pair at either cut costs one more each.
      assert.ok(head.length >= (max - 64) / 2 - 1 && tail.length >= (max - 64) / 2 - 1, 'both ends are kept');
    }
  });

  test('wireItem clips a tool\'s output and arguments only, and keeps an item that fits', () => {
    const small: ChatItem = { kind: 'tool', id: 't', name: 'write', args: '{"path":"a"}', output: 'ok', status: 'done' };
    assert.equal(wireItem(small), small);
    const text: ChatItem = { kind: 'assistant', id: 'a', text: 'x'.repeat(LIMITS.clip * 2), streaming: false };
    assert.equal(wireItem(text), text);
    const big = wireItem({ ...small, output: 'o'.repeat(LIMITS.clip + 1), args: `{"path":"a","content":"${'c'.repeat(LIMITS.clip)}"}` });
    assert.ok(big.kind === 'tool' && big.output.length <= LIMITS.clip && big.args.length <= LIMITS.clip);
    assert.ok(big.kind === 'tool' && big.args.startsWith('{"path":"a"'), 'the path stays readable');
  });

  test('a mirror of clipped items follows a tool whose output outgrows the limit', () => {
    let output = '';
    let sent: readonly ChatItem[] = [], mirror: readonly ChatItem[] = [];
    for (let i = 0; i < 12; i++) {
      output += `${'line of output '.repeat(500)}\n`;
      const wire = [{ kind: 'tool', id: 't', name: 'bash', args: '{}', output, status: 'running' } as const].map(wireItem);
      const ops = diffItems(sent, wire);
      assert.notEqual(ops, 'snapshot');
      const applied = ops === 'snapshot' ? 'resync' : applyOps(mirror, ops);
      assert.ok(applied !== 'resync');
      assert.deepEqual(applied, wire);
      const op = ops === 'snapshot' ? undefined : ops[0];
      assert.equal(op?.op, output.length <= LIMITS.clip ? (i ? 'append' : 'put') : 'put');
      sent = wire;
      mirror = applied;
    }
  });
});
