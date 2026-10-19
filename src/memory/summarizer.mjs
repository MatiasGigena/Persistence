// The default compaction model: one plain pi-ai completion through the host's Models (a pi-coding-agent
// ModelRuntime in this host, which resolves the stored credentials).

// Cheapest sensible model per provider in the pinned pi-ai 1.3.0 catalog: gpt-6-luna is $0.10/$0.50 per M tokens
// (cache read $0.01), against $2/$10 for the host's default gpt-6.1-sol, with the same 272k window and reasoning.
// Claude Haiku 5.5 is the same price on the API; through claude-cli it spends the least of the plan's limits.
export const CHEAP_MODELS = { 'openai-codex': 'gpt-6-luna', openai: 'gpt-6-luna', 'claude-cli': 'haiku', anthropic: 'claude-haiku-5-5' };

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The compaction model for a turn model: the provider's cheap model when the catalog has it, else the turn model. */
export function defaultCompactionModel(turnModel, models) {
  if (!turnModel) return undefined;
  const cheap = CHEAP_MODELS[turnModel.provider];
  return cheap && models?.getModel(turnModel.provider, cheap) ? { provider: turnModel.provider, modelId: cheap } : turnModel;
}

/**
 * `summarize(systemPrompt, messages, { signal, tools })` over `models.completeSimple()`. Tools, when given, are sent
 * with toolChoice "none" so the request shares the turns' cached prefix without calling them. The reply's size is
 * enforced by the caller, so `maxTokens` stays modest (reasoning tokens count toward it on OpenAI).
 */
export function createPiAiSummarizer({ models, model, reasoning = 'low', maxTokens, timeoutMs = 120_000, sessionId = 'uniichat-compactor' }) {
  return async (systemPrompt, messages, { signal, tools } = {}) => {
    if (!model) throw new Error('unii: no compaction model configured');
    const resolved = models.getModel(model.provider, model.modelId);
    if (!resolved) throw new Error(`unii: compaction model ${model.provider}/${model.modelId} is not in the catalog`);
    const now = Date.now();
    const context = {
      systemPrompt,
      ...(tools?.length ? { tools } : {}),
      messages: messages.map(m => m.role === 'assistant'
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
      throw new Error(reply.errorMessage ?? `compaction ended with ${reply.stopReason}`);
    }
    return reply.content.filter(block => block.type === 'text').map(block => block.text).join('');
  };
}
