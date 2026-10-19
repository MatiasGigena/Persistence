import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import {
  CompactionTask, defineExtension, defineTool, GenerationTask, hook, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';
import type { ConversationId, EntryRecord, Extension, HookApi } from '@earendil-works/pi-durable';
import { reportSrc } from './memory.ts';
import type { Memory, ReportInput } from './memory.ts';
import { PROMPT } from './prompt.ts';
import { CAP, clip, formatDate, hash, isObject } from './util.ts';

export const REPORT_KIND = 'agents.report';
const LOGGED = new Set(['stop', 'length', 'toolUse']);
/** What the extension reads of a pi-durable ContextView: entries (ids, kinds, data) and their model messages. */
export type ContextEntries = {
  readonly entries: readonly (Pick<EntryRecord, 'kind' | 'data'> & { readonly id: number })[];
  readonly contributions: readonly (readonly Message[])[];
};
/**
 * What beforeRequest uses of its HookApi. HookApi does not declare context(), but the task runtime behind it has it
 * (pi-durable's TaskRuntime.context, which returns a ContextView); without it, inputs are keyed by timestamp.
 */
export type RequestApi = Pick<HookApi, 'conversationId'> & {
  readonly context?: (conversationId: ConversationId, context: Context) => Promise<ContextEntries>;
};
export type UniiExtensionOptions = {
  memory: Memory;
  isRoot?: (conversationId: ConversationId) => boolean;
  /** The whole chat of agent `name`, for zoom("Name"). */
  resolveAgentChat?: (name: string) => string | Promise<string>;
  settleMs?: number;
  prevBytes?: number;
  now?: () => Date;
  name?: string;
};
type Content = UserMessage['content'] | ToolResultMessage['content'];
/** One loggable message of the context; `run`: it belongs to the current run. */
type Item = { m: UserMessage | AssistantMessage | ToolResultMessage; run: boolean; src: string; report?: ReportInput | undefined; calls?: string[] };

const isFinal = (m: Message | undefined): boolean => m?.role === 'assistant'
  && (m.stopReason === 'stop' || m.stopReason === 'length' || (m.stopReason === 'toolUse' && !m.content.some(b => b.type === 'toolCall')));
const textOf = (content: Content | undefined): string => typeof content === 'string' ? content
  : (content ?? []).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
const blocksOf = (content: UserMessage['content']): (TextContent | ImageContent)[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/** Log one assistant message: its text as `pi`, each tool call (name and JSON input) as `tool`. Never its thinking. */
function logAssistant(memory: Memory, message: AssistantMessage): void {
  if (!LOGGED.has(message.stopReason)) return;
  const date = message.timestamp ?? Date.now();
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  memory.append({ kind: 'pi', text, date, src: `a:${message.timestamp}:${hash(text)}` });
  for (const call of message.content.filter(b => b.type === 'toolCall')) {
    memory.append({ kind: 'tool', text: `${call.name} ${JSON.stringify(call.arguments ?? {})}`, date, src: `c:${call.id}` });
  }
}

function logResult(memory: Memory, { toolCallId, toolName, content, isError, timestamp }: {
  toolCallId: string; toolName: string; content: Content; isError?: boolean | undefined; timestamp?: number;
}): void {
  memory.append({ kind: 'echo', text: `${toolName}: ${isError ? 'error: ' : ''}${textOf(content)}`, date: timestamp ?? Date.now(), src: `r:${toolCallId}` });
}

function reportOf(entry: ContextEntries['entries'][number]): ReportInput | undefined {
  const { data } = entry;
  if (entry.kind !== REPORT_KIND || !isObject(data) || typeof data.name !== 'string' || typeof data.text !== 'string') return undefined;
  return { name: data.name, text: data.text, id: typeof data.id === 'string' || typeof data.id === 'number' ? data.id : undefined };
}
const userSrc = (entry: { readonly id: number }, n: number): string => `e:${entry.id}${n ? `:${n}` : ''}`;

/**
 * UniiChat as a pi-durable extension (recipe §5-§6), for the root conversation only.
 *
 * - Adds the recipe's system prompt as a section; the conversation's `instructions` (the user's) render after it.
 * - `beforeRequest` replaces each request of a run with [system] [view] [turn state: date/time] [previous exchange]
 *   [the run's new message] + the run's own steps. The view is rendered once per run, before the run's message is
 *   logged, after waiting up to `settleMs` for pending summaries (then placeholders).
 * - Logs user messages (an input entry of kind `agents.report` as `work`), replies, tool calls and tool results, each
 *   keyed (entry id, message timestamp, tool call id) so a replay never logs twice.
 * - Tools `zoom(id, n)` / `zoom("Name")` / `date(id)`; `resolveAgentChat(name)` answers `zoom("Name")`.
 * - Declines pi-durable's own compactions of the root; the host must still set `settings.compaction.enabled: false`.
 *
 * Options: `memory` (from openMemory), `isRoot(conversationId)` (default: pi-durable's ROOT_CONVERSATION_ID),
 * `resolveAgentChat(name) → string`, `settleMs` (8000), `prevBytes` (16000), `now()`, `name` ('uniichat').
 */
export function createUniiExtension({
  memory, isRoot = id => id === ROOT_CONVERSATION_ID, resolveAgentChat = async () => 'unknown agent',
  settleMs = 8_000, prevBytes = 16_000, now = () => new Date(), name = 'uniichat',
}: UniiExtensionOptions): Extension {
  if (!memory) throw new Error('createUniiExtension needs { memory }');
  const runs = new Map<string, TextContent[]>(); // run key -> frozen [view, state, previous exchange] blocks, so a run's requests share a prefix

  const zoom = defineTool({
    name: 'zoom',
    description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole (a long one comes in pages: page = 2, 3, ...). zoom("Name") gives an agent\'s whole chat.',
    parameters: Type.Object({
      id: Type.Union([Type.Integer({ minimum: 0 }), Type.String()], { description: 'First message id of the line, or an agent name' }),
      n: Type.Optional(Type.Integer({ minimum: 1, description: 'Messages the line covers (a power of 2); default 1' })),
      page: Type.Optional(Type.Integer({ minimum: 1, description: 'Page of a long message, with n = 1' })),
    }),
    replay: 'safe',
    outputLimits: { maxBytes: 256 * 1024, maxLines: 100_000 },
    execute: async ({ id, n = 1, page = 1 }) => {
      const text = typeof id === 'string' && !/^\d+$/.test(id.trim())
        ? String(await resolveAgentChat(id.replace(/^\[|\]$/g, '').trim()))
        : memory.zoom(Number(id), n, page);
      return { output: [{ type: 'text', text }] };
    },
  });
  const date = defineTool({
    name: 'date',
    description: 'The date and time of message id.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    replay: 'safe',
    execute: async ({ id }) => ({ output: [{ type: 'text', text: memory.date(id) }] }),
  });

  /**
   * The context from the last final answer on (that answer included, for catch-up), as loggable items in order:
   * `{ message, src, report?, user }`. With committed entries, inputs are keyed by entry id; without, by timestamp.
   */
  function items(messages: readonly Message[], view: ContextEntries | undefined): Item[] {
    const out: Item[] = [];
    const add = (m: Message, input: { report: ReportInput | undefined; src: string } | undefined, j: boolean): void => {
      if (m.role === 'user') out.push({ m, run: j, report: input?.report, src: input?.src ?? `u:${m.timestamp}:${hash(textOf(m.content))}` });
      else if (m.role === 'assistant') out.push({ m, run: j, src: `a:${m.timestamp}:${hash(m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))}`,
        calls: m.content.filter(b => b.type === 'toolCall').map(c => `c:${c.id}`) });
      else if (m.role === 'toolResult') out.push({ m, run: j, src: `r:${m.toolCallId}` });
    };
    if (view) {
      const { entries, contributions } = view;
      let from = entries.length;
      while (from > 0 && !contributions[from - 1]?.some(isFinal)) from--;
      for (let j = Math.max(0, from - 1); j < entries.length; j++) {
        const entry = entries[j];
        if (!entry) continue;
        const report = reportOf(entry);
        contributions[j]?.forEach((m, n) => add(m, m.role === 'user' ? { report, src: report ? reportSrc(report) : userSrc(entry, n) } : undefined, j >= from));
      }
    } else {
      const body = messages.filter(m => m.role !== 'system');
      let from = body.length;
      while (from > 0 && !isFinal(body[from - 1])) from--;
      body.slice(Math.max(0, from - 1)).forEach((m, n) => add(m, undefined, n > 0 || from === 0));
    }
    return out;
  }

  function log(item: Item): void {
    const { m } = item;
    if (m.role === 'user') {
      if (item.report) memory.report(item.report);
      else memory.append({ kind: 'user', text: textOf(m.content), date: m.timestamp, src: item.src });
    } else if (m.role === 'assistant') logAssistant(memory, m);
    else logResult(memory, m);
  }

  /**
   * Where the view ends for this run: before the run's own messages when they are already the log's tail (a run
   * resumed after a restart), else at the end of the log (a new run, whose message is logged after the render).
   */
  function viewEnd(run: readonly Item[]): number {
    const mine = new Set(run.flatMap(item => [item.src, ...(item.calls ?? [])]));
    let k = memory.T;
    while (k > 0 && mine.has((memory.log[k - 1]?.src ?? '').replace(/#\d+$/, ''))) k--;
    return k;
  }

  async function beforeRequest({ messages }: { readonly messages: readonly Message[] }, api: RequestApi, context: Context):
    Promise<{ messages: Message[] } | undefined> {
    if (!isRoot(api.conversationId)) return undefined;
    memory.setCompactionPrompt({ system: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) });
    const body = messages.filter(m => m.role !== 'system');
    let s = body.length;
    while (s > 0 && !isFinal(body[s - 1])) s--;
    const run = body.slice(s);

    // Committed entries give ids and kinds; HookApi does not declare context(), but the task runtime behind it has it.
    const view = typeof api.context === 'function' ? await api.context(api.conversationId, context) : undefined;
    const all = items(messages, view), mine = all.filter(item => item.run);
    const first = mine.find(item => item.m.role === 'user');
    const runKey = first && `${api.conversationId}:${first.src}`;

    let frozen = runKey ? runs.get(runKey) : undefined;
    if (!frozen) {
      if (!memory.ready(viewEnd(mine))) await memory.settle(settleMs, context?.abortSignal, viewEnd(mine));
      const k = viewEnd(mine); // the view is rendered before the run's message is logged (recipe §6)
      frozen = [memory.render(k), `<turn>\nnow: ${formatDate(now())}\n</turn>`, memory.previousExchange(k, prevBytes)]
        .filter(Boolean).map((text): TextContent => ({ type: 'text', text }));
      if (runKey) {
        runs.set(runKey, frozen);
        for (const old of runs.keys()) if (runs.size > 8) runs.delete(old);
      }
    }
    for (const item of all) log(item);

    const steps: Message[] = run.map(m => m.role !== 'toolResult' || typeof m.content === 'string' ? m
      : { ...m, content: m.content.map(b => b.type === 'text' && b.text.length > CAP ? { ...b, text: clip(b.text) } : b) });
    const head = steps[0];
    if (head?.role === 'user') steps[0] = { ...head, content: [...frozen, ...blocksOf(head.content)] };
    else steps.unshift({ role: 'user', content: frozen, timestamp: now().getTime() });
    const system = getCurrentSystemMessage(messages);
    return { messages: [...(system ? [system] : []), ...steps] };
  }

  return defineExtension({
    name,
    tools: [zoom, date],
    sections: [section('uniichat', () => PROMPT, { tag: false })],
    hooks: [
      hook(GenerationTask, {
        beforeRequest,
        afterResponse: (message, api) => { if (isRoot(api.conversationId)) logAssistant(memory, message); },
      }),
      hook(ToolTask, {
        afterTool: (call, result, api) => {
          // Logged as it happens; a call whose output streams (no `output` here) is logged by the next request.
          if (isRoot(api.conversationId) && !call.parent && result.output) {
            logResult(memory, { toolCallId: call.id, toolName: call.name, content: result.output, isError: result.isError });
          }
          return undefined;
        },
      }),
      hook(CompactionTask, { beforeCompact: (_compaction, api) => (isRoot(api.conversationId) ? { decline: true } : undefined) }),
    ],
  });
}
