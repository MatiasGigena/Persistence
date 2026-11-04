// The models Pi can switch to and whether each can be used now: the catalog cut to the routes of docs/models.md,
// each provider's credentials checked (and the anthropic subscription refused) the same way at launch and in session.
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef, UserInput } from '@earendil-works/pi-durable';
import { THINKING } from './thinking.ts';
import { anthropicSubscriptionSource } from '../providers/anthropic.ts';
import { CLAUDE_CLI } from '../providers/claude-cli.ts';
import type { ChatImage } from '../protocol/images.ts';
import { errorMessage } from '../protocol/util.ts';

/** What the listing and the checks read of pi-ai's Models (a pi-coding-agent ModelRuntime is one). */
export type CatalogModels = Pick<Models, 'getModels' | 'getModel' | 'checkAuth' | 'getAuth'>;

/** One model to pick from (the UI's ModelChoice). */
export interface ModelOption {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly note?: string;
}

/** A provider's credentials now. */
export type Access =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'none' | 'timeout' }
  | { readonly ok: false; readonly reason: 'subscription' | 'error'; readonly detail: string };

export interface CheckOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Listed after the current model's provider, in this order; openai only when it has credentials. */
const ROUTES = [CLAUDE_CLI, 'openai-codex', 'openai', 'anthropic'];
// Dated snapshots (gpt-4o-2024-08-06, claude-haiku-4-5-20251001) duplicate the aliases beside them.
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Check `provider`'s credentials within `timeoutMs`; never rejects. `anthropic` passes only with an API key: a Claude
 * subscription credential is refused (docs/models.md). The claude-cli check ignores signals, hence the race.
 */
export async function checkAccess(models: CatalogModels, provider: string, { timeoutMs = 15_000, signal }: CheckOptions = {}): Promise<Access> {
  // A held timer, not AbortSignal.timeout(): that one is unref'd, so a hung check could outlive an idle event loop.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const limit = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  const stopped = new Promise<'timeout'>(resolve => {
    if (limit.aborted) resolve('timeout');
    limit.addEventListener('abort', () => resolve('timeout'), { once: true });
  });
  const check = async (): Promise<Access> => {
    if (!await models.checkAuth(provider, { signal: limit })) return { ok: false, reason: 'none' };
    const subscription = provider === 'anthropic' ? await anthropicSubscriptionSource(models, { signal: limit }) : undefined;
    return subscription ? { ok: false, reason: 'subscription', detail: subscription } : { ok: true };
  };
  try {
    const result = await Promise.race([check(), stopped]);
    return result === 'timeout' ? { ok: false, reason: 'timeout' } : result;
  } catch (error) {
    return limit.aborted ? { ok: false, reason: 'timeout' } : { ok: false, reason: 'error', detail: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Why `model` cannot run, as a message for the user, or undefined when it can. `authFile` is named when given. */
export function accessProblem({ provider, modelId }: ModelRef, access: Access, authFile?: string): string | undefined {
  if (access.ok) return undefined;
  switch (access.reason) {
    case 'none': return provider === CLAUDE_CLI
      ? 'No Claude Code login for claude-cli. Install Claude Code, run claude, then /login (or run claude auth login). PI_DURABLE_CLAUDE_BIN selects another claude binary.'
      // Pi's /login for anthropic offers the Claude Pro/Max login, which the host refuses (the 'subscription' case).
      : provider === 'anthropic'
        ? 'No credentials for anthropic. Set ANTHROPIC_API_KEY to an Anthropic Console API key (sk-ant-api…), or use claude-cli/opus (or sonnet, haiku, fable) with your Claude plan through the claude CLI. A Claude Pro/Max login is refused for anthropic. See docs/models.md.'
        : `No credentials for ${provider}. Run pi (or npm exec -- pi from the installation directory), then /login. API-key providers also accept their usual environment variable.${authFile ? ` Auth file: ${authFile}` : ''}`;
    case 'subscription': return `Refusing anthropic/${modelId}: its credential is a Claude subscription (${access.detail}), which Anthropic allows only in its own apps such as Claude Code. Use claude-cli/opus (or sonnet, haiku, fable), which runs the official claude CLI with your login, or an Anthropic Console API key in ANTHROPIC_API_KEY (remove a stored anthropic login first). See docs/models.md.`;
    case 'timeout': return provider === CLAUDE_CLI
      ? 'Checking the credentials for claude-cli timed out: claude auth status did not answer. Run it yourself to see why.'
      : `Checking the credentials for ${provider} timed out.`;
    case 'error': return `Checking the credentials for ${provider} failed: ${access.detail}`;
  }
}

/** A user message's content: the text alone, or a text block (when not empty) and then the images. */
export function userInput(text: string, images: readonly ChatImage[] = []): UserInput {
  if (!images.length) return text;
  return [...text ? [{ type: 'text' as const, text }] : [], ...images.map(({ mimeType, data }) => ({ type: 'image' as const, mimeType, data }))];
}

/**
 * Why `model` cannot take images, or undefined when it can. pi-ai would otherwise replace them with a text note
 * (`downgradeUnsupportedImages`), so the model would answer about images it never saw.
 */
export function imagesProblem(models: Pick<Models, 'getModel'>, { provider, modelId }: ModelRef): string | undefined {
  const found = models.getModel(provider, modelId);
  if (found?.input.includes('image')) return undefined;
  return `${provider}/${modelId} does not take images; nothing was sent. Pick a model that does with /model, or send text only.`;
}

/** Why `model` is not in the catalog, or undefined when it is. */
export function catalogProblem(models: Pick<Models, 'getModel'>, { provider, modelId }: ModelRef): string | undefined {
  if (models.getModel(provider, modelId)) return undefined;
  return provider === CLAUDE_CLI ? `Unknown model claude-cli/${modelId}. Use opus, sonnet, haiku or fable.`
    : `Unknown model ${provider}/${modelId} in pinned Pi 1.5.0 catalog`;
}

/** The short hint shown beside a provider's models. */
function note(provider: string, access: Access): string | undefined {
  if (provider === CLAUDE_CLI) return access.ok ? 'uses your Claude plan via the claude CLI' : 'needs claude auth login';
  if (access.ok) return undefined;
  if (access.reason === 'timeout') return 'credential check timed out';
  if (provider === 'anthropic') return access.reason === 'subscription' ? 'subscription login refused; use claude-cli' : 'needs ANTHROPIC_API_KEY';
  return provider === 'openai-codex' ? 'needs a Pi login (/login in pi)' : 'no credentials';
}

/** The reasoning efforts `model` takes, lowest first; every level for a model not in the catalog. */
export function thinkingLevels(models: Pick<Models, 'getModel'>, model: ModelRef): ModelThinkingLevel[] {
  const found = models.getModel(model.provider, model.modelId);
  return found ? getSupportedThinkingLevels(found) : [...THINKING];
}

/** Lists and checks models; each provider's credentials are checked at most once per `ttlMs`. */
export interface ModelChooser {
  /** The models a user would pick, available or not: `current` first, then by provider. */
  list(current: ModelRef): Promise<ModelOption[]>;
  /** Rejects with a readable Error unless `model` is in the catalog and its provider's credentials pass, checked now. */
  check(model: ModelRef, options?: CheckOptions): Promise<void>;
}

export interface ChooserOptions {
  /** Per provider, when listing. Default 5 s. */
  readonly timeoutMs?: number;
  /** How long a listing reuses a provider's check. Default 60 s. */
  readonly ttlMs?: number;
  /** Named in the "No credentials" message. */
  readonly authFile?: string;
}

/**
 * A chooser over `models`. Listing checks every listed provider in parallel, each within `timeoutMs`: `claude-cli`
 * asks the `claude` CLI, so a first listing can take a second or two.
 */
export function modelChooser(models: CatalogModels, { timeoutMs = 5_000, ttlMs = 60_000, authFile }: ChooserOptions = {}): ModelChooser {
  const cache = new Map<string, { at: number; access: Promise<Access> }>();
  const remember = (provider: string, access: Promise<Access>): Promise<Access> => {
    cache.set(provider, { at: Date.now(), access });
    return access;
  };
  const accessOf = (provider: string): Promise<Access> => {
    const cached = cache.get(provider);
    return cached && Date.now() - cached.at < ttlMs ? cached.access : remember(provider, checkAccess(models, provider, { timeoutMs }));
  };

  return {
    async list(current) {
      const providers = [...new Set([current.provider, ...ROUTES])]
        .filter(provider => provider === current.provider || models.getModels(provider).length > 0);
      const access = new Map(await Promise.all(providers.map(async (provider): Promise<[string, Access]> => [provider, await accessOf(provider)])));
      const isCurrent = (provider: string, id: string): boolean => provider === current.provider && id === current.modelId;
      const options: ModelOption[] = [];
      for (const provider of providers) {
        const state = access.get(provider) ?? { ok: false, reason: 'none' };
        if (provider === 'openai' && !state.ok && provider !== current.provider) continue;
        const hint = note(provider, state);
        const listed = models.getModels(provider).filter(model => isCurrent(provider, model.id) || !SNAPSHOT.test(model.id));
        if (provider === current.provider && !listed.some(model => model.id === current.modelId)) {
          options.push({ provider, id: current.modelId, name: current.modelId, available: false, note: 'not in the catalog' });
        }
        for (const model of listed) {
          options.push({ provider, id: model.id, name: model.name, available: state.ok, ...(hint ? { note: hint } : {}) });
        }
      }
      const first = options.findIndex(option => isCurrent(option.provider, option.id));
      return first > 0 ? [...options.splice(first, 1), ...options] : options;
    },
    async check(model, options) {
      const unknown = catalogProblem(models, model);
      if (unknown) throw new Error(unknown);
      const problem = accessProblem(model, await remember(model.provider, checkAccess(models, model.provider, options)), authFile);
      if (problem) throw new Error(problem);
    },
  };
}
