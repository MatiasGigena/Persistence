// The user's search of the log as written (ADR 0040): which messages hold these words. A reading aid for the person
// at the terminal or the phone, never a tool of Pi's: by the recipe, zoom is the model's only way through its memory
// (prompt.ts). Pure and synchronous: no index, each search reads every record once.
import { isKind, KINDS } from './memory.ts';
import type { Kind, MemoryRecord } from './memory.ts';

/** One message a search found: its id in the log, its kind, when it was logged (ISO), and one line around the match. */
export type SearchHit = { id: number; kind: Kind; date: string; snippet: string };
/** A search's newest matches, and how many messages matched in all. */
export type SearchResult = { hits: SearchHit[]; total: number };
/** A parsed query: the terms a message must all hold, case folded, and the one kind to look in, if any. */
export type SearchQuery = { terms: string[]; kind?: Kind };

/** Hits one search returns at most. */
export const SEARCH_LIMIT = 50;
const SNIPPET = 160;   // characters of a hit's text its snippet shows
const LEAD = 24;       // of those, the ones before the match: a list row cut short still shows it
// As src/ui/text.ts `oneLine`: terminal escapes, and control characters other than newline and tab.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;
const lowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** `text` in lower case, the same length: a character whose lower case is longer (İ) stays, so indexes line up. */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return Array.from(text, c => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join('');
}

/**
 * A query's terms: words apart by whitespace, a part in double quotes one phrase (an unclosed quote runs to the end).
 * A `kind:name` word is no term: it limits the search to that kind, the last one given. Throws a readable Error for
 * an unknown kind, and for a query without a term.
 */
export function parseQuery(query: string): SearchQuery {
  const terms: string[] = [];
  let kind: Kind | undefined;
  for (const [, phrase, word = ''] of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const filter = phrase === undefined ? /^kind:(.*)$/i.exec(word)?.[1]?.toLowerCase() : undefined;
    if (filter === undefined) {
      const term = fold(phrase ?? word);
      if (term.trim()) terms.push(term);
    } else if (isKind(filter)) kind = filter;
    else throw new Error(`No kind "${filter}": kind: takes ${[...KINDS].join(', ')}.`);
  }
  if (!terms.length) throw new Error('Search for at least one word.');
  return kind === undefined ? { terms } : { terms, kind };
}

/** About SNIPPET characters of `text` around the match at `at`, on one line, with an ellipsis at each cut. */
function snippet(text: string, at: number): string {
  let start = Math.max(0, Math.min(at - LEAD, text.length - SNIPPET)), end = Math.min(text.length, start + SNIPPET);
  // A cut never halves a surrogate pair: it takes the whole character.
  if (start > 0 && lowSurrogate(text.charCodeAt(start))) start--;
  if (lowSurrogate(text.charCodeAt(end))) end++;
  const line = text.slice(start, end).replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${line}${end < text.length ? '…' : ''}`;
}

/**
 * The messages of `log` whose text holds every term of `query` as a substring, whatever the case, newest first: at
 * most `limit` hits, each with a snippet around the first term's first occurrence, and the count of all that match.
 * Each part of a split text is a message of its own. Throws as `parseQuery` does.
 */
export function searchLog(log: readonly MemoryRecord[], query: string, limit = SEARCH_LIMIT): SearchResult {
  const { terms, kind } = parseQuery(query), [first = ''] = terms;
  const hits: SearchHit[] = [];
  let total = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const record = log[i];
    if (!record || (kind !== undefined && record.kind !== kind)) continue;
    const text = fold(record.text);
    if (!terms.every(term => text.includes(term))) continue;
    if (total++ < limit) hits.push({ id: record.i, kind: record.kind, date: record.date, snippet: snippet(record.text, text.indexOf(first)) });
  }
  return { hits, total };
}
