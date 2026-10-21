import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import type { SimpleStreamOptions, Tool, TranscriptContext } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { CompactionRefused, createPiAiSummarizer, defaultCompactionModel, openMemory, PROMPT } from '../../src/memory/index.ts';
import type { AppendInput, CompactionMessage, Memory, SummarizeOptions, Summarizer } from '../../src/memory/index.ts';
import { offlineModels } from '../fixtures/faux-model.ts';
import { RULER } from '../../src/memory/prompt.ts';
import { bytes, CAP, cutLine, flat, hash, isObject, NODE } from '../../src/memory/util.ts';

const fake: Summarizer = async (_system, messages, { node }) => `summary of ${node.name} (${messages[0]?.content.length} chars in)`;

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'unii-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}
const owed = (m: Memory): number => { let n = 0; for (let k = m.T; k > 0; k = Math.floor(k / 2)) n += k; return n - m.tree.size; };
const quiet = { warn: () => {} };

describe('unii memory', { concurrency: false }, () => {
  test('log records {i, kind, text, size, date} in main/YYYY-MM-DD.jsonl, appended and readable', async (t) => {
    const dir = temp(t);
    const m = openMemory(dir, { summarize: fake, ...quiet });
    const [r] = m.append({ kind: 'user', text: 'hola €', date: '2026-01-02T03:04:05.000Z' });
    assert.ok(r);
    assert.deepEqual(r, { i: 0, kind: 'user', text: 'hola €', size: bytes('user: hola €'), date: '2026-01-02T03:04:05.000Z' });
    const files = readdirSync(join(dir, 'main'));
    const [file] = files;
    assert.ok(file && files.length === 1);
    assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const logged: unknown = JSON.parse(readFileSync(join(dir, 'main', file), 'utf8'));
    assert.deepEqual(logged, r);
    const thought: AppendInput = { kind: 'note', text: 'x' };
    Object.assign(thought, { kind: 'thought' }); // a kind outside Kind, as an untyped caller could pass
    assert.throws(() => m.append(thought), /unknown kind/);
    assert.throws(() => m.append({ kind: 'work', text: 'no name' }), /\[Name\]/);
    assert.deepEqual(m.append({ kind: 'pi', text: '   ' }), []);
    await m.close();
    assert.throws(() => m.append({ kind: 'user', text: 'late' }), /closed/);
  });

  test('tool output is clipped head+tail to 30,000 chars in all; other long text is split over consecutive messages, in one write', async (t) => {
    const dir = temp(t);
    const m = openMemory(dir, { summarize: fake, ...quiet });
    const echo = `${'h'.repeat(20_000)}MIDDLE${'t'.repeat(20_000)}`;
    const [clipped] = m.append({ kind: 'echo', text: echo });
    assert.ok(clipped);
    assert.ok(clipped.text.startsWith('h'.repeat(14_936)) && clipped.text.endsWith('t'.repeat(14_936)));
    assert.ok(!clipped.text.includes('MIDDLE'));
    assert.match(clipped.text, /\[… 10134 characters clipped …\]/);
    assert.ok(clipped.text.length <= CAP, 'the marker fits in the limit');
    const long = Array.from({ length: 1000 }, (_, n) => `line ${n} ${'x'.repeat(60)}`).join('\n');
    const parts = m.append({ kind: 'user', text: long, src: 'long' });
    assert.ok(parts.length === 3 && parts.every(p => p.text.length <= 30_000));
    assert.equal(parts.map(p => p.text).join(''), long);
    assert.deepEqual(parts.map(p => p.i), [1, 2, 3]);
    assert.deepEqual(parts.map(p => p.src), ['long', 'long#1', 'long#2']);
    assert.equal(readFileSync(join(dir, 'main', readdirSync(join(dir, 'main'))[0] ?? ''), 'utf8').trim().split('\n').length, 4);
    assert.match(m.zoom(1, 1), /^1\+1\|user: line 0 x+\n/, 'a logged text is one page');
    assert.throws(() => m.zoom(1, 1, 2), /has 1 page/);
    const [odd] = m.append({ kind: 'user', text: 'bad \ud800 surrogate' });
    assert.equal(odd?.text, 'bad \ufffd surrogate', 'text is made well-formed');
    await m.close();
  });

  test('an older record over 30,000 characters (an echo with its clip marker) comes in pages', async (t) => {
    const dir = temp(t);
    const text = `${'h'.repeat(15_000)}\n[… 5 characters clipped …]\n${'t'.repeat(15_000)}`;
    mkdirSync(join(dir, 'main'), { recursive: true });
    writeFileSync(join(dir, 'main', '2026-01-01.jsonl'), `${JSON.stringify({ i: 0, kind: 'echo', text, size: bytes(`echo: ${text}`), date: '2026-01-01T00:00:00.000Z' })}\n`);
    const m = openMemory(dir, { summarize: fake, ...quiet });
    assert.match(m.zoom(0, 1), /^0\+1 \(page 1 of 2; zoom\(0, 1, page\) for the others\)\|echo: h+\n\[… 5 characters clipped …\]\n$/);
    assert.match(m.zoom(0, 1, 2), /^0\+1 \(page 2 of 2; zoom\(0, 1, page\) for the others\)\|echo: t+$/);
    await m.close();
  });

  test('whole: a huge paste goes whole only in its last 128 KB, its first parts go to the view', async (t) => {
    const m = openMemory(temp(t), { summarize: fake, view: { hi: 70_000, lo: 35_000 }, ...quiet });
    m.append({ kind: 'user', text: 'before' });
    const paste = Array.from({ length: 2000 }, (_, n) => `row ${n} ${'p'.repeat(60)}`).join('\n');
    const parts = m.append({ kind: 'user', text: paste, src: 'e:9' });
    assert.equal(parts.length, 5);
    const k = m.whole(1);
    assert.equal(k, 4, 'the last two parts fit in 70,000 bytes, three do not');
    assert.ok(m.log.slice(k).reduce((n, r) => n + r.size, 0) <= 70_000);
    assert.equal(m.say(1), paste, 'parts rejoined');
    assert.equal(m.say(0, 2).startsWith('before\n\nrow 0'), true, 'messages a blank line apart');
    m.append({ kind: 'user', text: 'x'.repeat(80_000) });
    assert.equal(m.whole(m.T - 1), m.T - 1, 'the last message always goes whole');
    assert.equal(m.whole(1, Infinity), 1);
    await m.close();
  });

  test('src makes an append idempotent, also after a restart', async (t) => {
    const dir = temp(t);
    let m = openMemory(dir, { summarize: fake, ...quiet });
    assert.equal(m.append({ kind: 'user', text: 'once', src: 'e:7' }).length, 1);
    assert.equal(m.append({ kind: 'user', text: 'once', src: 'e:7' }).length, 0);
    await m.close();
    m = openMemory(dir, { summarize: fake, ...quiet });
    assert.equal(m.append({ kind: 'user', text: 'once', src: 'e:7' }).length, 0);
    assert.equal(m.T, 1);
    const [w] = m.report({ name: 'Bob', text: 'tests pass', id: 'r1' });
    assert.ok(w);
    assert.equal(w.kind, 'work');
    assert.equal(w.text, '[Bob]\ntests pass\n\nFull chat: zoom("Bob")', 'as Pi sees the report');
    assert.equal(w.src, 'report:r1', 'the src key is unchanged, so replays still dedupe');
    assert.deepEqual(m.report({ name: 'Bob', text: 'tests pass', id: 'r1' }), []);
    assert.equal(m.report({ name: 'Bob', text: 'again' })[0]?.src, `report:${hash('Bob\nagain')}`);
    const [coder] = m.report({ name: 'Coder', text: 'fixed', id: 'r2', session: 2 });
    assert.equal(coder?.text, '[Coder]\nfixed\n\nFull chat: zoom("Coder#2")', 'a standing agent\'s report links its session');
    assert.equal(coder?.src, 'report:r2');
    await m.close();
  });

  test('short messages are their own nodes, long ones call the model; the whole tree builds; reopen renders byte-identically', async (t) => {
    const dir = temp(t);
    let calls = 0;
    const counting: Summarizer = async (...args) => { calls++; return fake(...args); };
    const m = openMemory(dir, { summarize: counting, jobs: 4, ...quiet });
    for (let i = 0; i < 20; i++) m.append({ kind: i % 3 === 0 ? 'user' : 'echo', text: i % 3 === 0 ? `short ${i}` : 'x'.repeat(700 + i) });
    await until(() => owed(m) === 0);
    assert.equal(m.tree.get('0/0')?.text, 'user: short 0');
    assert.match(m.tree.get('0/1')?.text ?? '', /^summary of 1\+1/);
    assert.ok([...m.tree.values()].every(n => bytes(n.text) <= NODE));
    assert.equal(m.tree.get('1/0')?.text, 'user: short 0\nsummary of 1+1 (1307 chars in)'.replace('1307', m.tree.get('0/1')?.text.match(/\((\d+)/)?.[1] ?? ''));
    assert.ok(m.view.tiles(20));
    const rendered = m.render();
    const callsBefore = calls;
    await m.close();
    const again = openMemory(dir, { summarize: counting, ...quiet });
    assert.equal(again.render(), rendered);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(calls, callsBefore, 'every node is built once, never again');
    assert.equal(readFileSync(join(dir, 'tree', readdirSync(join(dir, 'tree'))[0] ?? ''), 'utf8').trim().split('\n').length, again.tree.size);
    await again.close();
  });

  test('the saved view is loaded, never refolded: it survives a budget change at restart', async (t) => {
    const dir = temp(t);
    const small = { hi: 600, lo: 300 };
    const m = openMemory(dir, { summarize: fake, view: small, ...quiet });
    for (let i = 0; i < 40; i++) m.append({ kind: 'user', text: `message number ${i}` });
    await until(() => owed(m) === 0);
    m.refit();
    const saved = m.view.parts.map(p => `${p.l}/${p.i}`);
    await m.close();
    const viewJson: unknown = JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8'));
    assert.ok(isObject(viewJson));
    assert.deepEqual(viewJson.view, saved.map(k => k.split('/').map(Number)));
    const reopened = openMemory(dir, { summarize: fake, ...quiet }); // default 64-128 KB budget
    assert.deepEqual(reopened.view.parts.map(p => `${p.l}/${p.i}`), saved);
    reopened.append({ kind: 'user', text: 'one more' });
    assert.deepEqual(reopened.view.parts.map(p => `${p.l}/${p.i}`), [...saved, '0/40'], 'a new message only appends its line');
    await reopened.close();
  });

  test('a log ahead of view.json (crash before the save) gets its lines appended; a gap in the log refuses to open', async (t) => {
    const dir = temp(t);
    const m = openMemory(dir, { summarize: fake, ...quiet });
    m.append({ kind: 'user', text: 'a' });
    await m.close();
    const file = join(dir, 'main', readdirSync(join(dir, 'main'))[0] ?? '');
    appendFileSync(file, `${JSON.stringify({ i: 1, kind: 'pi', text: 'b', size: 5, date: new Date().toISOString() })}\n`);
    const m2 = openMemory(dir, { summarize: fake, ...quiet });
    assert.equal(m2.T, 2);
    assert.ok(m2.view.tiles(2));
    await m2.close();
    appendFileSync(file, `${JSON.stringify({ i: 5, kind: 'pi', text: 'gap', size: 7, date: new Date().toISOString() })}\n`);
    assert.throws(() => openMemory(dir, { summarize: fake, ...quiet }), /not contiguous/);
  });

  test('one open per directory in a process', async (t) => {
    const dir = temp(t);
    const m = openMemory(dir, { summarize: fake, ...quiet });
    assert.throws(() => openMemory(dir, { summarize: fake, ...quiet }), /already open/);
    await m.close();
    await (openMemory(dir, { summarize: fake, ...quiet })).close();
  });

  test('zoom addressing and date', async (t) => {
    const m = openMemory(temp(t), { summarize: fake, ...quiet });
    for (let i = 0; i < 8; i++) m.append({ kind: 'user', text: `msg ${i} ${'y'.repeat(600)}`, date: new Date(2026, 0, 1 + i, 12) });
    await until(() => owed(m) === 0);
    assert.deepEqual(m.zoom(0, 8).split('\n').map(l => l.split('|')[0]), ['0+4', '4+4']);
    assert.deepEqual(m.zoom(4, 2).split('\n').map(l => l.split('|')[0]), ['4+1', '5+1']);
    assert.match(m.zoom(5, 1), /^5\+1\|user: msg 5 y/);
    assert.throws(() => m.zoom(3, 2), /multiple/);
    assert.throws(() => m.zoom(0, 3), /power of 2/);
    assert.throws(() => m.zoom(0, 16), /at most 8\. The tree's roots: 0\+8\.$/);
    assert.match(m.date(2), /^2026-01-03 12:00:00 [+-]\d\d:\d\d \(Saturday\)$/);
    assert.throws(() => m.date(9), /No message 9/);
    await m.close();
  });

  test('a failed compaction shows a placeholder and is retried', async (t) => {
    let fails = 2;
    const flaky: Summarizer = async (...args) => { if (fails-- > 0) throw new Error('boom'); return fake(...args); };
    const m = openMemory(temp(t), { summarize: flaky, jobs: 1, retryMs: 20, ...quiet });
    m.append({ kind: 'echo', text: 'z'.repeat(800) });
    assert.match(m.render(), /^<chat>\n0\+1\|\(not summarized yet: zoom it\)\n<\/chat>$/);
    await until(() => owed(m) === 0);
    assert.match(m.render(), /0\+1\|summary of 0\+1/);
    assert.equal(m.lastError, undefined);
    await m.close();
  });

  test('settle: false on timeout, true once built', async (t) => {
    let release: (() => void) | undefined;
    const slow = (): Promise<string> => new Promise(r => { release = () => r('done'); });
    const m = openMemory(temp(t), { summarize: slow, jobs: 1, ...quiet });
    m.append({ kind: 'echo', text: 'w'.repeat(600) });
    assert.equal(await m.settle(30), false);
    const waiting = m.settle(2000);
    await until(() => release !== undefined);
    release?.();
    assert.equal(await waiting, true);
    assert.equal(m.ready(), true);
    await m.close();
  });

  test('size: a too-long reply gets one "Too long" retry, a fresh call of the task and a note, then the cut', async (t) => {
    const seen: CompactionMessage[][] = [];
    const items = (n: number): string => Array.from({ length: n }, (_, k) => `user: item ${k} decided`).join('; ');
    const summarize: Summarizer = async (_system, messages) => { seen.push(messages.map(x => ({ ...x }))); return seen.length === 1 ? items(40) : items(30); };
    const m = openMemory(temp(t), { summarize, ...quiet });
    m.append({ kind: 'echo', text: 'q'.repeat(900) });
    await until(() => m.tree.has('0/0'));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]?.map(x => x.role), ['user'], 'never the long line itself');
    const first = seen[0]?.[0]?.content ?? '', retry = seen[1]?.[0]?.content ?? '';
    assert.ok(retry.startsWith(`${first}\n\nToo long: your last line for this <input> was ${bytes(items(40))} bytes,\nover the 512-byte limit.`));
    assert.match(retry, /\| ← LIMIT$/);
    const line = m.tree.get('0/0')?.text ?? '';
    assert.ok(bytes(line) <= NODE);
    assert.match(line, /decided$/, 'cut at the last "; "');
    await m.close();

    let one = 0;
    const m2 = openMemory(temp(t), { summarize: async () => { one++; return items(40); }, tooLongRetries: 0, ...quiet });
    m2.append({ kind: 'echo', text: 'q'.repeat(900) });
    await until(() => m2.tree.has('0/0'));
    assert.equal(one, 1);
    assert.ok(bytes(m2.tree.get('0/0')?.text ?? '') <= NODE);
    await m2.close();
  });

  test('a refusal or an empty answer makes the node its source, clipped; an outage is retried', async (t) => {
    const warnings: string[] = [];
    let calls = 0;
    const answers: (() => string)[] = [
      () => { throw new CompactionRefused('The model refused to complete the request'); },
      () => '',
      () => { throw new Error('overloaded'); },
    ];
    const summarize: Summarizer = async (...args) => { const next = answers[calls++]; return next ? next() : fake(...args); };
    const m = openMemory(temp(t), { summarize, jobs: 1, retryMs: 10, warn: w => warnings.push(w) });
    const text = `first line\n    indented ${'r'.repeat(700)}`;
    m.append({ kind: 'echo', text });
    m.append({ kind: 'echo', text: 'e'.repeat(700) });
    m.append({ kind: 'echo', text: 'o'.repeat(700) });
    await until(() => m.tree.has('0/0') && m.tree.has('0/1') && m.tree.has('0/2'));
    assert.equal(m.tree.get('0/0')?.text, flat(`echo: ${text}`).slice(0, NODE));
    assert.equal(m.tree.get('0/0')?.text, `echo: first line indented ${'r'.repeat(NODE - 26)}`);
    assert.equal(m.tree.get('0/1')?.text, `echo: ${'e'.repeat(NODE - 6)}`);
    assert.match(m.tree.get('0/2')?.text ?? '', /^summary of 2\+1/, 'an outage is not clipped');
    assert.ok(warnings.some(w => /0\+1: The model refused.*clipped/.test(w)));
    assert.ok(warnings.some(w => /1\+1: an empty line.*clipped/.test(w)));
    await m.close();
  });

  test('view.json naming a node the tree lost opens it into its halves, without refolding', async (t) => {
    const dir = temp(t);
    const m = openMemory(dir, { summarize: fake, view: { hi: 600, lo: 300 }, ...quiet });
    for (let i = 0; i < 40; i++) m.append({ kind: 'user', text: `message number ${i}` });
    await until(() => owed(m) === 0);
    m.refit();
    const lost = m.view.parts.find(p => p.l >= 2);
    assert.ok(lost);
    const lostKey = `${lost.l}/${lost.i}`;
    await m.close();
    const treeDir = join(dir, 'tree');
    for (const file of readdirSync(treeDir)) {
      const kept = readFileSync(join(treeDir, file), 'utf8').split('\n').filter(line => {
        if (!line) return false;
        const n: unknown = JSON.parse(line);
        return !(isObject(n) && `${String(n.l)}/${String(n.i)}` === lostKey);
      });
      writeFileSync(join(treeDir, file), kept.map(line => `${line}\n`).join(''));
    }
    const warnings: string[] = [];
    const again = openMemory(dir, { summarize: async () => new Promise<string>(() => {}), view: { hi: 600, lo: 300 }, warn: w => warnings.push(w) });
    const keys = again.view.parts.map(p => `${p.l}/${p.i}`);
    assert.ok(!keys.includes(lostKey));
    assert.ok(keys.includes(`${lost.l - 1}/${2 * lost.i}`) && keys.includes(`${lost.l - 1}/${2 * lost.i + 1}`));
    assert.ok(again.view.tiles(40));
    assert.deepEqual(warnings, []);
    await again.close(0);
  });

  test('flat turns each newline and the whitespace around it into one space', () => {
    assert.equal(flat('a\n    b \r\n\n c'), 'a b c');
    assert.equal(flat('no newline  here'), 'no newline  here');
  });

  test('cutLine strips echoed heads and fences and cuts safely', () => {
    assert.equal(cutLine('12+4|hello world').line, 'hello world');
    assert.equal(cutLine('263|pi: removed it').line, 'pi: removed it');
    assert.equal(cutLine('```\nhello\n```').line, 'hello');
    const r = cutLine(Array.from({ length: 40 }, (_, i) => `user: decisión ${i} en /a/b/${i}`).join('; '));
    assert.ok(r.cut && bytes(r.line) <= NODE);
    assert.match(r.line, /\/a\/b\/\d+$/);
    assert.ok(bytes(cutLine('é'.repeat(400)).line) <= NODE);
  });

  test('compaction calls: the turns\' system prompt, a <chat> view that ends at the node, the task with the 512-dash ruler', async (t) => {
    const calls: (SummarizeOptions & { system: string; text: string })[] = [];
    const summarize: Summarizer = async (system, messages, options) => {
      calls.push({ system, text: messages[0]?.content ?? '', ...options });
      return `S${options.node.name} ${'s'.repeat(490)}`;
    };
    const m = openMemory(temp(t), { summarize, ...quiet });
    const tools: Tool[] = [{ name: 'zoom', description: 'z', parameters: Type.Object({}) }];
    m.setCompactionPrompt({ system: `${PROMPT}\n\nINSTRUCTIONS`, tools });
    m.append({ kind: 'user', text: 'first short' });
    m.append({ kind: 'echo', text: `OUTPUT ${'o'.repeat(700)}` });
    await until(() => m.tree.has('1/0'));
    const leaf = calls.find(c => c.node.name === '1+1');
    assert.ok(leaf);
    assert.equal(leaf.system, `${PROMPT}\n\nINSTRUCTIONS`);
    assert.deepEqual(leaf.tools, tools);
    assert.ok(leaf.text.startsWith('<chat>\n0+1|user: first short\n</chat>\n\nCompaction: compress message 1 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n'));
    assert.ok(leaf.text.includes(`\n${RULER}\n<input>\necho: OUTPUT o`));
    assert.equal(RULER.length, 512);
    const merge = calls.find(c => c.node.name === '0+2');
    assert.ok(merge);
    assert.ok(merge.text.includes('Compaction: merge lines 0+1 and 1+1, adjacent, into one line of at most\n512 bytes'));
    assert.ok(merge.text.includes('<chat> may hold their messages, 0 to 1, in more detail'));
    assert.ok(merge.text.includes(`<input>\nuser: first short\nS1+1 ${'s'.repeat(490)}\n</input>`), 'the halves\' texts, without heads');
    assert.ok(merge.text.startsWith(`<chat>\n0+1|user: first short\n1+1|S1+1 ${'s'.repeat(490)}\n</chat>`), 'a merge sees the lines up to its last message');
    await m.close();
  });

  test('order: at most 8 calls, in message order; a leaf starts once fewer than 8 leaves before it are unbuilt; a merge once both halves are built', async (t) => {
    const pending = new Map<string, () => void>(), started: string[] = [], early: string[] = [];
    let m: Memory | undefined, inFlight = 0, most = 0;
    const summarize: Summarizer = (_s, _m, { node }) => new Promise(r => {
      started.push(node.name);
      most = Math.max(most, ++inFlight);
      if (node.l > 0 && !(m?.tree.has(`${node.l - 1}/${2 * node.i}`) && m.tree.has(`${node.l - 1}/${2 * node.i + 1}`))) early.push(node.name);
      pending.set(node.name, () => { inFlight--; pending.delete(node.name); r(`S${node.name} ${'s'.repeat(490)}`); });
    });
    m = openMemory(temp(t), { summarize, ...quiet });
    for (let i = 0; i < 20; i++) m.append({ kind: 'echo', text: `${i} ${'e'.repeat(700)}` });
    await until(() => started.length === 8);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(started, ['0+1', '1+1', '2+1', '3+1', '4+1', '5+1', '6+1', '7+1']);
    pending.get('1+1')?.();
    await until(() => started.length === 9);
    assert.equal(started[8], '8+1', 'leaf 0 still unbuilt, 7 open before 8: it may start');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(started.length, 9, 'leaf 9 has 8 unbuilt leaves before it: it waits');
    pending.get('0+1')?.();
    await until(() => started.length === 10);
    assert.equal(started[9], '0+2', 'in message order: the merge ending at 2 before leaf 9');
    pending.get('2+1')?.();
    await until(() => started.length === 11);
    assert.equal(started[10], '9+1');
    while (owed(m) > 0) {
      for (const release of [...pending.values()]) release();
      await new Promise(r => setTimeout(r, 2));
    }
    assert.deepEqual(early, []);
    assert.ok(most <= 8);
    assert.ok(started.includes('0+16'));
    await m.close(0);
  });

  test('default summarizer: one pi-ai completion with the system prompt, the conversation, tools with toolChoice none', async () => {
    let seen: { ctx: TranscriptContext; options: SimpleStreamOptions | undefined } | undefined;
    const { models, model } = offlineModels([
      (ctx, options) => { seen = { ctx, options }; return fauxAssistantMessage('a line'); },
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limited' }),
      () => ({ ...fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'refused' }), rawStopReason: 'refusal' }),
    ]);
    const summarize = createPiAiSummarizer({ models, model, maxTokens: 300 });
    const tools: Tool[] = [{ name: 'zoom', description: 'z', parameters: Type.Object({}) }];
    const text = await summarize('SYSTEM', [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'long line' }, { role: 'user', content: 'Too long' }], { tools });
    assert.equal(text, 'a line');
    assert.equal(seen?.options?.toolChoice, 'none');
    assert.equal(seen.options?.maxTokens, 300);
    assert.deepEqual(seen.ctx.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(seen.ctx.messages[0]?.content, 'SYSTEM');
    await assert.rejects(summarize('SYSTEM', [{ role: 'user', content: 'task' }]), (error: unknown) => error instanceof Error && !(error instanceof CompactionRefused) && /rate limited/.test(error.message));
    await assert.rejects(summarize('SYSTEM', [{ role: 'user', content: 'task' }]), CompactionRefused);
    const catalog = { getModel: (_provider: string, id: string) => (id === 'gpt-6-luna' ? { id } : undefined) };
    assert.deepEqual(defaultCompactionModel({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, catalog), { provider: 'openai-codex', modelId: 'gpt-6-luna' });
    assert.deepEqual(defaultCompactionModel({ provider: 'anthropic', modelId: 'x' }, catalog), { provider: 'anthropic', modelId: 'x' });
    const claude = { getModel: (provider: string, id: string) => (`${provider}/${id}` === 'claude-cli/haiku' || `${provider}/${id}` === 'anthropic/claude-haiku-5-5' ? { id } : undefined) };
    assert.deepEqual(defaultCompactionModel({ provider: 'claude-cli', modelId: 'opus' }, claude), { provider: 'claude-cli', modelId: 'haiku' });
    assert.deepEqual(defaultCompactionModel({ provider: 'anthropic', modelId: 'claude-opus-5-5' }, claude), { provider: 'anthropic', modelId: 'claude-haiku-5-5' });
  });
});
