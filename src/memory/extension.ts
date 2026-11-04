import type { Context } from '@earendil-works/chord';
import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { getCurrentSystemMessage, getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import {
  CompactionTask, defineTool, GenerationTask, hook, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';
import type { ConversationId, EntryRecord, Extension, HookApi, ToolRegistration } from '@earendil-works/pi-durable';
import { int, obj, opt, str, union } from '@earendil-works/pi-schema';
import { reportSrc } from './memory.ts';
import type { Memory, ReportInput } from './memory.ts';
import { PROMPT } from './prompt.ts';
import { CAP, clip, formatDate, hash } from './util.ts';
import { agentInputOf } from '../agents/entries.ts';
import { NotFound } from '../protocol/errors.ts';

// Adapted from UniiChat's Server.ts HEAD (Apache-2.0): a turn's head, as a compaction's is "Compaction:", so the one
// prompt tells the two apart.
export const TURN_HEAD = 'Turn: the user\'s new message:\n\n';
const LOGGED = new Set(['stop', 'length', 'toolUse']);
/** What the extension reads of a pi-durable ContextView: entries (ids, kinds, data, messages, writer) and their model messages. */
export type ContextEntries = {
  readonly entries: readonly (Pick<EntryRecord, 'kind' | 'data' | 'model'> & { readonly id: number; readonly byTaskId?: number })[];
  readonly contributions: readonly (readonly Message[])[];
};
/**
 * What beforeRequest uses of its HookApi. HookApi does not declare context(), but the task runtime behind it has it
 * (pi-durable's TaskRuntime.context, which returns a ContextView); without it, inputs are keyed by timestamp.
 * `taskId`: the generation task asking; replies other tasks wrote belong to earlier runs.
 */
export type RequestApi = Pick<HookApi, 'conversationId'> & {
  readonly taskId?: number;
  readonly context?: (conversationId: ConversationId, context: Context) => Promise<ContextEntries>;
};
/** The extension, with its tools always present (Pi's agent enables them by name). */
export type UniiExtension = Extension & { readonly tools: readonly ToolRegistration[] };
export type UniiExtensionOptions = {
  /** Absent only for inspection: the extension is installed so stored names resolve, and any turn or tool call throws. */
  memory: Memory | undefined;
  isRoot?: (conversationId: ConversationId) => boolean;
  /** Page `page` (from 1) of agent `name`'s whole chat, for zoom("Name"); a short chat is one page. */
  resolveAgentChat?: (name: string, page: number) => string | Promise<string>;
  /** The names of the agents working now, for the turn state; without it, the turn state does not list them. */
  atWork?: () => readonly string[] | Promise<readonly string[]>;
  settleMs?: number;
  prevBytes?: number;
  now?: () => Date;
  name?: string;
};
type Content = UserMessage['content'] | ToolResultMessage['content'];
/**
 * One loggable message of the context; `run`: it belongs to the current run; `cut`: a reply pi-durable keeps out of
 * the model's context (aborted, or the last of a failed run), logged with a cut mark.
 */
type Item = { m: UserMessage | AssistantMessage | ToolResultMessage; run: boolean; src: string; report?: ReportInput | undefined;
  calls?: string[]; cut?: boolean };

/** A run's request head, computed once: [view, turn state, previous exchange], and the message's tail for a huge input. */
type Frozen = { blocks: TextContent[]; message: string | undefined };
const baseSrc = (src: string | undefined): string => (src ?? '').replace(/#\d+$/, '');

const isFinal = (m: Message | undefined): boolean => m?.role === 'assistant'
  && (m.stopReason === 'stop' || m.stopReason === 'length' || (m.stopReason === 'toolUse' && !m.content.some(b => b.type === 'toolCall')));
const textOf = (content: Content | undefined): string => typeof content === 'string' ? content
  : (content ?? []).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
const blocksOf = (content: UserMessage['content']): (TextContent | ImageContent)[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;
// Joined with '\n', unlike agents/entries.ts's `text`: the hash of this text is the reply's persisted `src` key, so it
// stays as it is.
const replyText = (m: AssistantMessage): string => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const replySrc = (m: AssistantMessage): string => `a:${m.timestamp}:${hash(replyText(m))}`;
const callsOf = (m: AssistantMessage): ToolCall[] => m.content.filter(b => b.type === 'toolCall');
/** A reply pi-durable keeps out of the model's context: stopped, or failed. */
const isCut = (m: Message): m is AssistantMessage => m.role === 'assistant' && (m.stopReason === 'aborted' || m.stopReason === 'error');
// Adapted from UniiChat's Agent.ts `fail` (Apache-2.0): what a cut reply had written ends with why it was cut.
const cutMark = (m: AssistantMessage): string =>
  `\n[cut off: ${(m.stopReason === 'aborted' ? 'stopped' : m.errorMessage || 'error').slice(0, 300)}]`;

/** Log an assistant message's text as `pi`, never its thinking; a `cut` one with its cut mark. Its calls go with their results. */
function logReply(memory: Memory, message: AssistantMessage, cut = false): void {
  if (!cut && !LOGGED.has(message.stopReason)) return;
  const text = replyText(message);
  memory.append({ kind: 'pi', text: cut && text.trim() ? text + cutMark(message) : text, date: message.timestamp ?? Date.now(), src: replySrc(message) });
}

/** Log a tool call as `tool`: its name and JSON input. */
function logCall(memory: Memory, call: ToolCall, date: number): void {
  memory.append({ kind: 'tool', text: `${call.name} ${JSON.stringify(call.arguments ?? {})}`, date, src: `c:${call.id}` });
}

/** Log a tool result as `echo`, right after its call (as UniiChat logs a call with its result), when the call is known. */
function logResult(memory: Memory, { toolCallId, toolName, content, isError, timestamp }: {
  toolCallId: string; toolName: string; content: Content; isError?: boolean | undefined; timestamp?: number;
}, call: ToolCall | undefined): void {
  const date = timestamp ?? Date.now();
  if (call) logCall(memory, call, date);
  memory.append({ kind: 'echo', text: `${toolName}: ${isError ? 'error: ' : ''}${textOf(content)}`, date, src: `r:${toolCallId}` });
}

function reportOf(entry: ContextEntries['entries'][number]): ReportInput | undefined {
  const input = agentInputOf(entry);
  return input?.kind === 'report' ? { name: input.from, text: input.text, id: input.id, session: input.session } : undefined;
}
const userSrc = (entry: { readonly id: number }, n: number): string => `e:${entry.id}${n ? `:${n}` : ''}`;

/** A reply another generation task wrote: an earlier run's, which ended there or later. */
const earlier = (entry: ContextEntries['entries'][number] | undefined, taskId: number | undefined): boolean =>
  taskId !== undefined && entry?.byTaskId !== undefined && entry.byTaskId !== taskId && (entry.model ?? []).some(m => m.role === 'assistant');

/**
 * Where the current run starts in `view`: at the first user message after the last final answer or, with `taskId`,
 * after the last reply of an earlier run, so a failed or stopped run is never carried raw into the next one (its
 * messages are in the log, hence the view). `end`: that earlier entry (-1: none).
 */
function runBounds({ entries, contributions }: ContextEntries, taskId: number | undefined): { end: number; from: number } {
  let end = entries.length - 1;
  while (end >= 0 && !contributions[end]?.some(isFinal) && !earlier(entries[end], taskId)) end--;
  let from = end + 1;
  while (from < entries.length && !contributions[from]?.some(m => m.role === 'user')) from++;
  return from < entries.length || taskId === undefined ? { end, from } : runBounds({ entries, contributions }, undefined);
}

/** The run's first message, its head marked (UniiChat Server.ts HEAD), its text and images as sent. */
function headed(content: UserMessage['content']): (TextContent | ImageContent)[] {
  const [first, ...rest] = blocksOf(content);
  return first?.type === 'text' ? [{ ...first, text: TURN_HEAD + first.text }, ...rest]
    : [{ type: 'text', text: TURN_HEAD.trimEnd() }, ...(first ? [first] : []), ...rest];
}

/**
 * UniiChat as a pi-durable extension (recipe §5-§6), for the root conversation only.
 *
 * - Adds the recipe's system prompt as a section; the conversation's `instructions` (the user's) render after it.
 * - `beforeRequest` replaces each request of a run with [system] [view] [turn state: date/time, agents at work]
 *   [previous exchange] [`Turn: the user's new message:` and the run's new message] + the run's own steps. The view
 *   is rendered once per run, ending before the run's message (logged first, so a huge one's first parts go to the
 *   view and only its tail is sent), after waiting up to `settleMs` for pending summaries (then placeholders). A run
 *   starts after the last final answer, or after the last reply of an earlier (failed or stopped) run.
 * - Logs user messages (an input entry of kind `agents.report` as `work`), replies, and each tool call with its result,
 *   each keyed (entry id, message timestamp, tool call id) so a replay never logs twice. A reply cut by a stop or a
 *   failure is logged by the next run, with `[cut off: why]`; a call left without a result, alone.
 * - Tools `zoom(id, n)` / `zoom("Name")` / `date(id)`; `resolveAgentChat(name, page)` answers `zoom("Name")`.
 * - Gives compactions the turns' system prompt, without tools.
 * - Declines every pi-durable compaction of the root. The host turns pi-durable's compaction on for agents (ADR 0015),
 *   so this decline is what keeps Pi uncompacted: its view keeps its context a constant size.
 *
 * Options: `memory` (from openMemory), `isRoot(conversationId)` (default: pi-durable's ROOT_CONVERSATION_ID),
 * `resolveAgentChat(name, page) → string`, `atWork() → names`, `settleMs` (8000), `prevBytes` (16000), `now()`,
 * `name` ('uniichat').
 */
export function createUniiExtension({
  memory, isRoot = id => id === ROOT_CONVERSATION_ID, resolveAgentChat = name => Promise.reject(new NotFound(`No agent named ${name}.`)), atWork,
  settleMs = 8_000, prevBytes = 16_000, now = () => new Date(), name = 'uniichat',
}: UniiExtensionOptions): UniiExtension {
  const open = (): Memory => {
    if (!memory) throw new Error('unii: memory is not open (inspection only)');
    return memory;
  };
  const runs = new Map<string, Frozen>(); // run key -> its frozen blocks and message, so a run's requests share a prefix

  const zoom = defineTool({
    name: 'zoom',
    description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole (a long one comes in pages: page = 2, 3, ...). zoom("Name") gives an agent\'s whole chat, a long one in pages too.',
    parameters: obj({
      id: union([int({ minimum: 0 }), str()], { description: 'First message id of the line, or an agent name' }),
      n: opt(int({ minimum: 1, description: 'Messages the line covers (a power of 2); default 1' })),
      page: opt(int({ minimum: 1, description: 'Page of a long message or chat, with n = 1' })),
    }, { open: true }),
    replay: 'safe',
    outputLimits: { maxBytes: 256 * 1024, maxLines: 100_000 },
    execute: async ({ id, n = 1, page = 1 }) => {
      const agent = typeof id === 'string' && !/^\d+$/.test(id.trim()) ? id.replace(/^\[|\]$/g, '').trim() : undefined;
      const text = agent !== undefined ? String(await resolveAgentChat(agent, page)) : open().zoom(Number(id), n, page);
      return { output: [{ type: 'text', text }] };
    },
  });
  const date = defineTool({
    name: 'date',
    description: 'The date and time of message id.',
    parameters: obj({ id: int({ minimum: 0 }) }, { open: true }),
    replay: 'safe',
    execute: async ({ id }) => ({ output: [{ type: 'text', text: open().date(id) }] }),
  });

  /**
   * The context from the end of the previous run on (its last reply included, for catch-up), as loggable items in
   * order, and where the run's messages start in `body`. With committed entries, inputs are keyed by entry id; without,
   * by timestamp.
   */
  function items(body: readonly Message[], view: ContextEntries | undefined, taskId: number | undefined): { all: Item[]; start: number } {
    const all: Item[] = [];
    const add = (m: Message, input: { report: ReportInput | undefined; src: string } | undefined, run: boolean): void => {
      if (m.role === 'user') all.push({ m, run, report: input?.report, src: input?.src ?? `u:${m.timestamp}:${hash(textOf(m.content))}` });
      else if (m.role === 'assistant') all.push({ m, run, src: replySrc(m), calls: callsOf(m).map(c => `c:${c.id}`) });
      else if (m.role === 'toolResult') all.push({ m, run, src: `r:${m.toolCallId}` });
    };
    let from = body.length;
    while (from > 0 && !isFinal(body[from - 1])) from--;
    if (!view) {
      body.slice(Math.max(0, from - 1)).forEach((m, n) => add(m, undefined, n > 0 || from === 0));
      return { all, start: from };
    }
    const { entries, contributions } = view;
    const bounds = runBounds(view, taskId);
    for (let j = Math.max(0, bounds.end); j < entries.length; j++) {
      const entry = entries[j];
      if (!entry) continue;
      const report = reportOf(entry);
      const messages = contributions[j] ?? [];
      messages.forEach((m, n) => add(m, m.role === 'user' ? { report, src: report ? reportSrc(report) : userSrc(entry, n) } : undefined, j >= bounds.from));
      const cut = messages.length === 0 && j === bounds.end ? entry.model?.find(isCut) : undefined;
      if (cut) all.push({ m: cut, run: false, src: replySrc(cut), cut: true });
    }
    // The run's messages are the tail of `body` that its entries contribute; any mismatch keeps the final-answer rule.
    const count = contributions.slice(bounds.from).flat().filter(m => m.role !== 'system').length;
    const start = body.length - count;
    return { all, start: count > 0 && body[start]?.role === 'user' ? start : from };
  }

  /** Log `items` in order, each tool call with its result; calls left without one are logged alone, before the next input. */
  function log(items: readonly Item[]): void {
    const calls = new Map<string, { call: ToolCall; date: number }>();
    const unanswered = (): void => {
      for (const { call, date } of calls.values()) logCall(open(), call, date);
      calls.clear();
    };
    for (const item of items) {
      const { m } = item;
      if (m.role === 'user') {
        unanswered();
        if (item.report) open().report(item.report);
        else open().append({ kind: 'user', text: textOf(m.content), date: m.timestamp, src: item.src });
      } else if (m.role === 'assistant') {
        logReply(open(), m, item.cut);
        for (const call of callsOf(m)) calls.set(call.id, { call, date: m.timestamp ?? Date.now() });
      } else {
        logResult(open(), m, calls.get(m.toolCallId)?.call);
        calls.delete(m.toolCallId);
      }
    }
    unanswered();
  }

  /**
   * Where the run's own records start: before the run's messages at the log's tail (they are logged before the view is
   * rendered), so the run's message is never in its own view (recipe §6), after a restart too.
   */
  function viewEnd(run: readonly Item[]): number {
    const mine = new Set(run.flatMap(item => [item.src, ...(item.calls ?? [])]));
    let k = open().T;
    while (k > 0 && mine.has(baseSrc(open().log[k - 1]?.src))) k--;
    return k;
  }

  /**
   * The run's frozen blocks. The run's input is logged first, so `whole` can measure it: the view ends at `k`, where
   * the input's parts start going whole (upstream Memory.ts `whole`); a huge paste's first parts are in the view, and
   * the message is only its tail, `joinedText(k, end)`.
   */
  async function freeze(mine: readonly Item[], first: Item | undefined, signal: AbortSignal | undefined): Promise<Frozen> {
    const memory = open();
    const from = viewEnd(mine);
    let end = from;
    while (first && end < memory.T && baseSrc(memory.log[end]?.src) === first.src) end++;
    // Later records of a resumed run count in firstWhole() too; the clamp keeps the input's last part whole.
    const k = end > from ? Math.min(memory.firstWhole(from), end - 1) : from;
    if (!memory.ready(k)) await memory.settle(settleMs, signal, k);
    const working = atWork ? await atWork() : undefined;
    const state = ['<turn>', `now: ${formatDate(now())}`,
      ...(working ? [`agents at work: ${working.length ? working.join(', ') : 'none'}`] : []), '</turn>'].join('\n');
    const blocks = [memory.render(k), state, memory.previousExchange(k, prevBytes)]
      .filter(Boolean).map((text): TextContent => ({ type: 'text', text }));
    return { blocks, message: k > from ? memory.joinedText(k, end) : undefined };
  }

  async function beforeRequest({ messages }: { readonly messages: readonly Message[] }, api: RequestApi, context: Context):
    Promise<{ messages: Message[] } | undefined> {
    if (!isRoot(api.conversationId)) return undefined;
    // Upstream gives compactions the turns' system prompt and no tools: the compaction model is usually another
    // model, so tools would buy no shared cache.
    open().setCompactionPrompt({ system: getCurrentSystemPrompt(messages) });
    const body = messages.filter(m => m.role !== 'system');

    // Committed entries give ids and kinds; HookApi does not declare context(), but the task runtime behind it has it.
    const view = typeof api.context === 'function' ? await api.context(api.conversationId, context) : undefined;
    const { all, start } = items(body, view, api.taskId);
    const run = body.slice(start), mine = all.filter(item => item.run);
    const first = mine.find(item => item.m.role === 'user');
    const runKey = first && `${api.conversationId}:${first.src}`;

    log(all.filter(item => !item.run)); // an earlier run's tail precedes this run's view
    log(mine);
    let frozen = runKey ? runs.get(runKey) : undefined;
    if (!frozen) {
      frozen = await freeze(mine, first, context?.abortSignal);
      if (runKey) {
        runs.set(runKey, frozen);
        for (const old of runs.keys()) if (runs.size > 8) runs.delete(old);
      }
    }

    const steps: Message[] = run.map(m => m.role !== 'toolResult' || typeof m.content === 'string' ? m
      : { ...m, content: m.content.map(b => b.type === 'text' && b.text.length > CAP ? { ...b, text: clip(b.text) } : b) });
    const head = steps[0];
    const { blocks, message } = frozen;
    // A huge input goes as its tail (text); its images still go with it, since the log keeps only `[image]`.
    if (head?.role === 'user') steps[0] = { ...head, content: [...blocks, ...headed(message === undefined ? head.content : [
      { type: 'text', text: message }, ...blocksOf(head.content).filter(b => b.type === 'image')])] };
    else steps.unshift({ role: 'user', content: blocks, timestamp: now().getTime() });
    const system = getCurrentSystemMessage(messages);
    return { messages: [...(system ? [system] : []), ...steps] };
  }

  return {
    name,
    tools: [zoom, date],
    sections: [section('uniichat', () => PROMPT, { tag: false })],
    hooks: [
      hook(GenerationTask, {
        beforeRequest,
        afterResponse: (message, api) => { if (isRoot(api.conversationId)) logReply(open(), message); },
      }),
      hook(ToolTask, {
        afterTool: (call, result, api) => {
          // Logged as it happens, the call first; a call whose output streams (no `output` here) is logged by the next request.
          if (isRoot(api.conversationId) && !call.parent && result.output) {
            logResult(open(), { toolCallId: call.id, toolName: call.name, content: result.output, isError: result.isError }, call);
          }
          return undefined;
        },
      }),
      hook(CompactionTask, { beforeCompact: (_compaction, api) => (isRoot(api.conversationId) ? { decline: true } : undefined) }),
    ],
  };
}
