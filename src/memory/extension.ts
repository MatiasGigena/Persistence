import { Type } from '@earendil-works/pi-ai';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import {
  CompactionTask, defineExtension, defineTool, GenerationTask, hook, ROOT_CONVERSATION_ID, section, ToolTask,
} from '@earendil-works/pi-durable';
import { reportSrc } from './memory.ts';
import { PROMPT } from './prompt.ts';
import { CAP, clip, formatDate, hash } from './util.ts';

export const REPORT_KIND = 'agents.report';
const LOGGED = new Set(['stop', 'length', 'toolUse']);
const isFinal = m => m.role === 'assistant'
  && (m.stopReason === 'stop' || m.stopReason === 'length' || (m.stopReason === 'toolUse' && !m.content.some(b => b.type === 'toolCall')));
const textOf = content => typeof content === 'string' ? content
  : (content ?? []).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
const blocksOf = content => typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/** Log one assistant message: its text as `pi`, each tool call (name and JSON input) as `tool`. Never its thinking. */
function logAssistant(memory, message) {
  if (!LOGGED.has(message.stopReason)) return;
  const date = message.timestamp ?? Date.now();
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  memory.append({ kind: 'pi', text, date, src: `a:${message.timestamp}:${hash(text)}` });
  for (const call of message.content.filter(b => b.type === 'toolCall')) {
    memory.append({ kind: 'tool', text: `${call.name} ${JSON.stringify(call.arguments ?? {})}`, date, src: `c:${call.id}` });
  }
}

function logResult(memory, { toolCallId, toolName, content, isError, timestamp }) {
  memory.append({ kind: 'echo', text: `${toolName}: ${isError ? 'error: ' : ''}${textOf(content)}`, date: timestamp ?? Date.now(), src: `r:${toolCallId}` });
}

const reportOf = entry => entry.kind === REPORT_KIND && typeof entry.data?.name === 'string' && typeof entry.data?.text === 'string'
  ? entry.data : undefined;
const userSrc = (entry, n) => `e:${entry.id}${n ? `:${n}` : ''}`;

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
}) {
  if (!memory) throw new Error('createUniiExtension needs { memory }');
  const runs = new Map(); // run key -> frozen [view, state, previous exchange] blocks, so a run's requests share a prefix

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
  function items(messages, view) {
    const out = [];
    const add = (m, input, j) => {
      if (m.role === 'user') out.push({ m, run: j, user: true, report: input?.report, src: input?.src ?? `u:${m.timestamp}:${hash(textOf(m.content))}` });
      else if (m.role === 'assistant') out.push({ m, run: j, src: `a:${m.timestamp}:${hash(m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))}`,
        calls: m.content.filter(b => b.type === 'toolCall').map(c => `c:${c.id}`) });
      else if (m.role === 'toolResult') out.push({ m, run: j, src: `r:${m.toolCallId}` });
    };
    if (view) {
      const { entries, contributions } = view;
      let from = entries.length;
      while (from > 0 && !contributions[from - 1].some(isFinal)) from--;
      for (let j = Math.max(0, from - 1); j < entries.length; j++) {
        const report = reportOf(entries[j]);
        contributions[j].forEach((m, n) => add(m, m.role === 'user' && { report, src: report ? reportSrc(report) : userSrc(entries[j], n) }, j >= from));
      }
    } else {
      const body = messages.filter(m => m.role !== 'system');
      let from = body.length;
      while (from > 0 && !isFinal(body[from - 1])) from--;
      body.slice(Math.max(0, from - 1)).forEach((m, n) => add(m, undefined, n > 0 || from === 0));
    }
    return out;
  }

  function log(item) {
    if (item.user) {
      if (item.report) memory.report(item.report);
      else memory.append({ kind: 'user', text: textOf(item.m.content), date: item.m.timestamp, src: item.src });
    } else if (item.m.role === 'assistant') logAssistant(memory, item.m);
    else logResult(memory, item.m);
  }

  /**
   * Where the view ends for this run: before the run's own messages when they are already the log's tail (a run
   * resumed after a restart), else at the end of the log (a new run, whose message is logged after the render).
   */
  function viewEnd(run) {
    const mine = new Set(run.flatMap(item => [item.src, ...(item.calls ?? [])]));
    let k = memory.T;
    while (k > 0 && mine.has((memory.log[k - 1].src ?? '').replace(/#\d+$/, ''))) k--;
    return k;
  }

  async function beforeRequest({ messages }, api, context) {
    if (!isRoot(api.conversationId)) return undefined;
    memory.setCompactionPrompt({ system: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) });
    const body = messages.filter(m => m.role !== 'system');
    let s = body.length;
    while (s > 0 && !isFinal(body[s - 1])) s--;
    const run = body.slice(s);

    // Committed entries give ids and kinds; HookApi does not declare context(), but the task runtime behind it has it.
    const view = typeof api.context === 'function' ? await api.context(api.conversationId, context) : undefined;
    const all = items(messages, view), mine = all.filter(item => item.run);
    const first = mine.find(item => item.user);
    const runKey = first && `${api.conversationId}:${first.src}`;

    let frozen = runKey && runs.get(runKey);
    if (!frozen) {
      if (!memory.ready(viewEnd(mine))) await memory.settle(settleMs, context?.abortSignal, viewEnd(mine));
      const k = viewEnd(mine); // the view is rendered before the run's message is logged (recipe §6)
      frozen = [memory.render(k), `<turn>\nnow: ${formatDate(now())}\n</turn>`, memory.previousExchange(k, prevBytes)]
        .filter(Boolean).map(text => ({ type: 'text', text }));
      if (runKey) {
        runs.set(runKey, frozen);
        for (const old of runs.keys()) if (runs.size > 8) runs.delete(old);
      }
    }
    for (const item of all) log(item);

    const steps = run.map(m => m.role !== 'toolResult' || typeof m.content === 'string' ? m
      : { ...m, content: m.content.map(b => b.type === 'text' && b.text.length > CAP ? { ...b, text: clip(b.text) } : b) });
    if (steps[0]?.role === 'user') steps[0] = { ...steps[0], content: [...frozen, ...blocksOf(steps[0].content)] };
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
