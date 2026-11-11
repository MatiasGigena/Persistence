import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { openMemory } from '../../src/memory/index.ts';
import type { AppendInput, Memory, SearchHit } from '../../src/memory/index.ts';
import { parseQuery, SEARCH_LIMIT, searchLog } from '../../src/memory/search.ts';
import { CAP } from '../../src/memory/util.ts';

/** A memory in its own directory, holding `messages` in order; nothing in these tests summarizes. */
function memoryOf(t: TestContext, messages: readonly AppendInput[]): Memory {
  const dir = mkdtempSync(join(tmpdir(), 'unii-search-'));
  const memory = openMemory(dir, { summarize: async () => 'a summary', warn: () => {} });
  t.after(async () => {
    await memory.close(0);
    rmSync(dir, { recursive: true, force: true });
  });
  for (const message of messages) memory.append(message);
  return memory;
}

const ids = (hits: readonly SearchHit[]): number[] => hits.map(hit => hit.id);

describe('the search query', () => {
  test('words and quoted phrases are terms, in lower case; kind: is a filter, not a term', () => {
    assert.deepEqual(parseQuery('Deploy  FRIDAY'), { terms: ['deploy', 'friday'] });
    assert.deepEqual(parseQuery('"Exactly This" deploy'), { terms: ['exactly this', 'deploy'] });
    assert.deepEqual(parseQuery('  deploy kind:user '), { terms: ['deploy'], kind: 'user' });
    assert.deepEqual(parseQuery('KIND:Pi deploy kind:work'), { terms: ['deploy'], kind: 'work' }, 'any case; the last one counts');
    assert.deepEqual(parseQuery('"kind:user"'), { terms: ['kind:user'] }, 'a quoted filter is searched for');
    assert.deepEqual(parseQuery('it"s "" x'), { terms: ['it"s', 'x'] }, 'a quote inside a word is a character; an empty phrase is none');
    assert.deepEqual(parseQuery('say "to the end'), { terms: ['say', 'to the end'] }, 'an unclosed quote runs to the end');
    assert.deepEqual(parseQuery('İstanbul ÉTÉ'), { terms: ['İstanbul', 'été'] }, 'a letter whose lower case is longer stays');
  });

  test('a query without a word, or with an unknown kind, is refused readably', () => {
    for (const query of ['', '   ', '""', 'kind:user', ' kind:pi  kind:tool ']) assert.throws(() => parseQuery(query), { message: 'Search for at least one word.' }, query);
    assert.throws(() => parseQuery('deploy kind:human'), { message: 'No kind "human": kind: takes user, pi, tool, echo, work, note.' });
    assert.throws(() => parseQuery('deploy kind:'), /No kind "": kind: takes user,/);
  });
});

describe('searching the log', () => {
  const day = (n: number): string => new Date(2026, 10, n, 9).toISOString();
  const talk: readonly AppendInput[] = [
    { kind: 'user', text: 'When do we deploy the harbor app?', date: day(1) },
    { kind: 'pi', text: 'Deploy on Friday, after the tide tables are in.', date: day(1) },
    { kind: 'tool', text: 'bash {"command":"make deploy"}', date: day(2) },
    { kind: 'echo', text: 'deployed harbor to staging\nexactly this time', date: day(2) },
    { kind: 'work', text: '[Scout]\nThe DEPLOY is green.\n\nFull chat: zoom("Scout")', date: day(3) },
    { kind: 'note', text: 'unrelated: buy coffee', date: day(4) },
  ];

  test('every term must occur, as a substring and whatever the case; hits come newest first with id, kind and date', t => {
    const memory = memoryOf(t, talk);
    const all = memory.search('deploy');
    assert.equal(all.total, 5);
    assert.deepEqual(all.hits.map(({ id, kind, date }) => ({ id, kind, date })), [
      { id: 4, kind: 'work', date: day(3) }, { id: 3, kind: 'echo', date: day(2) }, { id: 2, kind: 'tool', date: day(2) },
      { id: 1, kind: 'pi', date: day(1) }, { id: 0, kind: 'user', date: day(1) },
    ]);
    assert.deepEqual(ids(memory.search('HARBOR deploy').hits), [3, 0], 'both words, in any order');
    assert.deepEqual(ids(memory.search('deploy tide').hits), [1]);
    assert.deepEqual(memory.search('deploy zeppelin'), { hits: [], total: 0 });
    assert.deepEqual(ids(memory.search('arbo').hits), [3, 0], 'a part of a word matches');
  });

  test('a quoted phrase matches only as written, and kind: keeps one kind', t => {
    const memory = memoryOf(t, talk);
    assert.deepEqual(ids(memory.search('time exactly').hits), [3]);
    assert.deepEqual(ids(memory.search('"exactly this"').hits), [3]);
    assert.deepEqual(ids(memory.search('"this exactly"').hits), []);
    assert.deepEqual(ids(memory.search('"deploy the" harbor').hits), [0]);
    assert.deepEqual(ids(memory.search('deploy kind:pi').hits), [1]);
    assert.deepEqual(ids(memory.search('kind:WORK deploy').hits), [4]);
    assert.deepEqual(memory.search('coffee kind:user'), { hits: [], total: 0 });
    assert.throws(() => memory.search('kind:note'), { message: 'Search for at least one word.' });
    assert.throws(() => memory.search('coffee kind:nobody'), /No kind "nobody"/);
  });

  test('at most `limit` hits, the newest ones, and the total counts every match', t => {
    const memory = memoryOf(t, Array.from({ length: 60 }, (_, n): AppendInput => ({ kind: n % 2 ? 'pi' : 'user', text: `boat ${n}` })));
    const found = memory.search('boat');
    assert.equal(found.total, 60);
    assert.equal(found.hits.length, SEARCH_LIMIT);
    assert.deepEqual(ids(found.hits).slice(0, 3), [59, 58, 57]);
    assert.equal(found.hits.at(-1)?.id, 10);
    const three = memory.search('boat kind:user', 3);
    assert.deepEqual([ids(three.hits), three.total], [[58, 56, 54], 30]);
    assert.deepEqual(searchLog(memory.log, '"boat 4"', 1), { hits: [{ id: 49, kind: 'pi', date: memory.at(49).date, snippet: 'boat 49' }], total: 11 });
  });

  test('a snippet is one line around the first term\'s first occurrence, with an ellipsis at each cut', t => {
    const before = 'lead '.repeat(40), after = ' tail'.repeat(60);
    const memory = memoryOf(t, [
      { kind: 'user', text: 'short and whole' },
      { kind: 'pi', text: `needle first.\n\n  Then\ta  second line${after}` },
      { kind: 'pi', text: `${before}the needle sits here${after}` },
      { kind: 'pi', text: `${before}the needle ends it` },
      { kind: 'echo', text: 'red \u001b[31malert\u001b[0m needle\u0007 bell' },
    ]);
    const [control, end, middle, start] = memory.search('needle').hits.map(hit => hit.snippet);
    assert.equal(memory.search('whole').hits[0]?.snippet, 'short and whole');
    assert.ok(start && middle && end);
    assert.ok(start.length > 150 && start.length <= 161, 'about 160 characters, less the whitespace that closed up');
    assert.ok(start.startsWith('needle first. Then a second line tail tail') && start.endsWith('…'), start);
    assert.match(middle, /^…(lead ){4}the needle sits here tail .*…$/, 'two dozen characters lead to the match');
    assert.ok(middle.length <= 162, middle);
    assert.ok(end.startsWith('…') && end.endsWith('the needle ends it'), end);
    assert.ok(end.length <= 161 && end.length > 150, 'a match near the end keeps a full snippet before it');
    assert.equal(control, 'red alert needle bell', 'no terminal escapes or control characters');
    // The snippet follows the first term of the query, not the first match in the text.
    assert.match(memory.search('here needle').hits[0]?.snippet ?? '', /^….{0,24}here tail/);
    assert.match(memory.search('SITS').hits[0]?.snippet ?? '', /needle sits here/, 'the text keeps its case');
  });

  test('a cut never halves a surrogate pair, and a letter that grows in lower case does not move the snippet', t => {
    const boats = '⛵🚤'.repeat(100);
    const memory = memoryOf(t, [
      { kind: 'user', text: `${boats}x needle ${boats}` },
      { kind: 'user', text: `${'İ'.repeat(300)} needle in İstanbul ${'z'.repeat(300)}` },
    ]);
    for (const query of ['needle', 'x', '"x needle"', '🚤x', 'İstanbul']) {
      for (const { snippet } of memory.search(query).hits) assert.equal(snippet, snippet.toWellFormed(), query);
    }
    const [turkish, emoji] = memory.search('needle').hits.map(hit => hit.snippet);
    assert.match(emoji ?? '', /^…(⛵🚤|🚤)+x needle (⛵🚤)+⛵?…$/u);
    assert.match(turkish ?? '', /^…İ{23} needle in İstanbul z+…$/);
    assert.deepEqual(ids(memory.search('i̇stanbul').hits), [], 'İ matches itself, not its two-character lower case');
  });

  test('each part of a text split over several messages is its own hit', t => {
    const paste = `${'a line of the paste\n'.repeat(1600)}the anchor at the end`;
    assert.ok(paste.length > CAP && paste.length < 2 * CAP);
    const memory = memoryOf(t, [{ kind: 'user', text: 'before', src: 'm:0' }, { kind: 'user', text: paste, src: 'm:1' }]);
    assert.deepEqual(memory.log.map(record => record.src), ['m:0', 'm:1', 'm:1#1']);
    assert.deepEqual(ids(memory.search('paste').hits), [2, 1]);
    assert.deepEqual(ids(memory.search('anchor').hits), [2]);
    assert.deepEqual(ids(memory.search('paste anchor').hits), [2], 'terms are not matched across parts');
  });

  test('a search writes nothing and leaves the view alone', t => {
    const memory = memoryOf(t, talk);
    const before = JSON.stringify([memory.log, memory.view.parts, memory.status()]);
    memory.search('deploy');
    assert.equal(JSON.stringify([memory.log, memory.view.parts, memory.status()]), before);
  });
});
