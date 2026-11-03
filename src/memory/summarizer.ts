// The default compaction model: one plain pi-ai completion through the host's Models (a pi-coding-agent
// ModelRuntime in this host, which resolves the stored credentials).
import type { Message, Models, SimpleStreamOptions, Tool, Usage } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';

/** A compaction conversation: the task, then any "Too long" back and forth. */
export type CompactionMessage = { role: 'user' | 'assistant'; content: string };
/** The node being built: level, index, and its `id+n` name. */
export type CompactionNode = { l: number; i: number; name: string };
export type SummarizeOptions = { signal?: AbortSignal; tools?: readonly Tool[]; node: CompactionNode };
/**
 * The model answered, but with no line, and asking again would fail alike (a refusal, a safety stop): the node is its
 * source clipped (UniiChat Memory.ts `build`). Any other error is an outage, and the node is tried again.
 */
export class CompactionRefused extends Error {
  override name = 'CompactionRefused';
}

/**
 * The compaction model: one line for the messages, as text (the caller cleans and cuts it). '' or a CompactionRefused
 * means the model answered without a line; any other throw, that it could not answer.
 */
export type Summarizer = (systemPrompt: string, messages: readonly CompactionMessage[], options: SummarizeOptions) => Promise<string>;
/** What the default summarizer needs of a pi-ai Models (a pi-coding-agent ModelRuntime is one). */
export type SummarizerModels = Pick<Models, 'getModel' | 'completeSimple'>;
export type Reasoning = NonNullable<SimpleStreamOptions['reasoning']>;
export type PiAiSummarizerOptions = {
  models: SummarizerModels;
  model: ModelRef | undefined;
  reasoning?: Reasoning;
  maxTokens?: number | undefined;
  timeoutMs?: number;
  sessionId?: string;
};

// Cheapest sensible model per provider in the pinned pi-ai 1.5.0 catalog: gpt-6-luna is $0.10/$0.50 per M tokens
// (cache read $0.01), against $2/$10 for the host's default gpt-6.1-sol, with the same 272k window and reasoning.
// Claude Haiku 5.5 is the same price on the API; through claude-cli it spends the least of the plan's limits.
export const CHEAP_MODELS: Readonly<Record<string, string>> = { 'openai-codex': 'gpt-6-luna', openai: 'gpt-6-luna', 'claude-cli': 'haiku', anthropic: 'claude-haiku-5-5' };

// Anthropic stop reasons pi-ai reports as errors although the model answered (its input's doing).
const REFUSALS: ReadonlySet<string> = new Set(['refusal', 'sensitive']);

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The compaction model for a turn model: the provider's cheap model when the catalog has it, else the turn model. */
export function defaultCompactionModel(turnModel: ModelRef | undefined, models: { getModel(provider: string, id: string): unknown } | undefined): ModelRef | undefined {
  if (!turnModel) return undefined;
  const cheap = CHEAP_MODELS[turnModel.provider];
  return cheap && models?.getModel(turnModel.provider, cheap) ? { provider: turnModel.provider, modelId: cheap } : turnModel;
}

/**
 * `summarize(systemPrompt, messages, { signal, tools })` over `models.completeSimple()`. Tools, when given, are sent
 * with toolChoice "none" so the request shares the turns' cached prefix without calling them. The reply's size is
 * enforced by the caller, so `maxTokens` stays modest (reasoning tokens count toward it on OpenAI).
 */
export function createPiAiSummarizer({
  models, model, reasoning = 'low', maxTokens, timeoutMs = 120_000, sessionId = 'uniichat-compactor',
}: PiAiSummarizerOptions): (systemPrompt: string, messages: readonly CompactionMessage[], options?: Partial<SummarizeOptions>) => Promise<string> {
  return async (systemPrompt, messages, { signal, tools } = {}) => {
    if (!model) throw new Error('unii: no compaction model configured');
    const resolved = models.getModel(model.provider, model.modelId);
    if (!resolved) throw new Error(`unii: compaction model ${model.provider}/${model.modelId} is not in the catalog`);
    const now = Date.now();
    const context = {
      systemPrompt,
      ...(tools?.length ? { tools: [...tools] } : {}),
      messages: messages.map((m): Message => m.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'text', text: m.content }], api: resolved.api, provider: resolved.provider,
          model: resolved.id, usage: ZERO_USAGE, stopReason: 'stop', timestamp: now }
        : { role: 'user', content: m.content, timestamp: now }),
    };
    const reply = await models.completeSimple(resolved, context, {
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]),
      maxTokens: maxTokens ?? (resolved.reasoning ? 4_000 : 400),
      ...(resolved.reasoning ? { reasoning } : {}),
      ...(tools?.length ? { toolChoice: 'none' } : {}),
      sessionId,
    });
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      const message = reply.errorMessage ?? `compaction ended with ${reply.stopReason}`;
      throw reply.stopReason === 'error' && REFUSALS.has(reply.rawStopReason ?? '') ? new CompactionRefused(message) : new Error(message);
    }
    return reply.content.filter(block => block.type === 'text').map(block => block.text).join('');
  };
}
