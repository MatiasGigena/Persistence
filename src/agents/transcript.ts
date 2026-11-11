// An agent's whole chat as text, in pages: what zoom("Name") answers.
import type { Context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { Cursor, EntryRecord } from '@earendil-works/pi-durable';
import { MESSAGE_KIND, agentInputOf, text } from './entries.ts';
import { NotFound } from '../protocol/errors.ts';
import { PI, AgentsDoc, findAgent, noAgent, deletedAgent } from './registry.ts';
import type { AgentsSource } from './registry.ts';

/** The most characters of an agent's chat that one zoom("Name") page holds (upstream UniiChat Clip.ts CAP). */
export const TRANSCRIPT_PAGE = 30_000;

/** An input entry's own text, from its data: `[from X] text` or `[X] text`, never the view preamble. */
export function inputText(entry: EntryRecord): string | undefined {
  const input = agentInputOf(entry);
  if (!input) return undefined;
  return input.kind === 'message' ? `[from ${input.from}] ${input.text}` : `[${input.from}] ${input.text}`;
}

/**
 * Where the page of `all` from `at` ends: `max` characters on, after its last newline if it has one
 * there. Adapted from upstream UniiChat's `clip_end` (Clip.ts, Apache-2.0).
 */
export function pageEnd(all: string, at: number, max: number): number {
  if (all.length - at <= max) return all.length;
  const newline = all.lastIndexOf('\n', at + max - 1);
  const low = (all.charCodeAt(at + max) & 0xfc00) === 0xdc00; // never split a surrogate pair
  return newline >= at ? newline + 1 : at + max - (low ? 1 : 0);
}

/**
 * An agent's whole chat as text (backs the memory's `zoom("Name")`), in the format of upstream
 * UniiChat's agent log: one `i|kind: text` line per message, blank lines between, oldest first.
 * Kinds: `user` (an input: `[from X] text`, or `[X] text` for a report), the agent's name (its
 * replies), `tool` (its calls), `echo` (their results, whole), `note` (the view preamble left out, a
 * compaction). `page` (from 1) gives one page of at most `TRANSCRIPT_PAGE` characters, saying how to
 * go on; without it, the whole chat. `source` is the Harness or a tool's `api`; `name` may be "Pi".
 */
export async function agentTranscript(
  source: AgentsSource, context: Context, name: string, page?: number,
): Promise<string> {
  const registry = await source.snapshot(AgentsDoc, context);
  // "Name#n" is a standing agent's session n, 1 the oldest; plain "Name" its current one.
  const [, base = String(name), number] = /^(.*?)#(\d+)$/.exec(String(name).trim()) ?? [];
  const agents = registry?.agents ?? {};
  const gone = deletedAgent(registry, base);
  const agent = base.toLowerCase() === PI.toLowerCase()
    ? { name: PI, conversationId: ROOT_CONVERSATION_ID, standing: false, past: [] } : findAgent(agents, base) ?? gone;
  if (!agent) throw new NotFound(noAgent(agents, base));
  const sessions = [...agent.past ?? [], agent.conversationId];
  const index = number === undefined ? sessions.length : Number(number);
  const conversationId = sessions[index - 1];
  if (conversationId === undefined || index < 1) {
    throw new NotFound(`No session ${number}: ${agent.name} has ${sessions.length === 1 ? '1 session' : `${sessions.length} sessions`}.`);
  }
  // A standing agent's (or any with past sessions) transcript says which session it is.
  const header = [
    ...agent === gone ? [`${agent.name} was deleted; its chat is kept`] : [],
    ...agent.standing || sessions.length > 1
      ? [`session ${index} of ${sessions.length}${index === sessions.length ? ' (current)' : ''}`] : [],
  ];
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const scanned = await source.commit((tx) => tx.scanEntries(
      { conversationId, order: 'ascending' }, 256, cursor), context);
    entries.push(...scanned.items);
    cursor = scanned.next;
  } while (cursor !== undefined);
  const lines: string[] = [];
  const add = (kind: string, value: string) => lines.push(`${lines.length}|${kind}: ${value}`);
  for (const entry of entries) {
    // Compacted messages stay stored and are shown whole above; only mark where the context was cut.
    if (entry.kind === 'pi.compaction') { add('note', 'the context was compacted here'); continue; }
    const input = inputText(entry);
    for (const message of entry.model ?? []) {
      if (message.role === 'user') {
        const said = text(message.content);
        // Only a message can carry the view; a report to Pi differs from `[X] text` by its zoom hint.
        if (entry.kind === MESSAGE_KIND && input !== undefined && said !== input) add('note', 'the first message also held Pi\'s view at the spawn (not shown)');
        add('user', input ?? said);
      } else if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) add(agent.name, block.text);
          else if (block.type === 'toolCall') add('tool', `${block.name}(${JSON.stringify(block.arguments)})`);
        }
      } else if (message.role === 'toolResult') {
        add('echo', `${message.toolName}: ${message.isError ? 'error: ' : ''}${text(message.content)}`);
      }
    }
  }
  const all = [...header, ...lines].join('\n\n');
  if (page === undefined) return all;
  let end = pageEnd(all, 0, TRANSCRIPT_PAGE);
  const ends = [end];
  while (end < all.length) ends.push(end = pageEnd(all, end, TRANSCRIPT_PAGE));
  if (!Number.isSafeInteger(page) || page < 1 || page > ends.length) throw new NotFound(`No page ${page}: ${agent.name}'s chat has ${ends.length}.`);
  const body = all.slice(ends[page - 2] ?? 0, ends[page - 1]);
  return page < ends.length ? `${body}\n[page ${page} of ${ends.length}; go on with page ${page + 1}]` : body;
}
