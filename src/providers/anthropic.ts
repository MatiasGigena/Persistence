import type { AuthOperationOptions, Models } from '@earendil-works/pi-ai';

// Anthropic allows a Claude subscription only through its own apps, Claude Code included, not through other
// harnesses (docs/models.md). pi-ai's `anthropic` provider can sign in with Claude Pro/Max and then impersonates Claude
// Code, so the host refuses that provider whenever its credential is a subscription token.

/** The part of pi-ai's Models the check reads. */
export type AnthropicAuthModels = Pick<Models, 'checkAuth' | 'getAuth'>;

/** Subscription OAuth tokens (`claude setup-token`, Claude Code's own login) start `sk-ant-oat`; API keys `sk-ant-api`. */
const OAUTH_TOKEN = 'sk-ant-oat';

/**
 * Where the `anthropic` provider's credential is a Claude subscription, or undefined when it is not (an API key, a
 * gateway token, or no credential). The stored type and the env source are read first, so an OAuth login is never
 * refreshed or resolved here; only an API-key credential is resolved, to look at the key itself.
 */
export async function anthropicSubscriptionSource(models: AnthropicAuthModels, { signal }: AuthOperationOptions = {}): Promise<string | undefined> {
  const check = await models.checkAuth('anthropic', { signal });
  if (!check) return undefined;
  if (check.type === 'oauth') return 'the Claude Pro/Max login stored in the auth file';
  if (check.source === 'ANTHROPIC_OAUTH_TOKEN') return 'ANTHROPIC_OAUTH_TOKEN';
  const resolved = await models.getAuth('anthropic', { signal });
  const { apiKey = '', headers = {} } = resolved?.auth ?? {};
  const bearer = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
  return `${apiKey}\n${bearer}`.includes(OAUTH_TOKEN) ? `a subscription token in ${resolved?.source ?? 'the anthropic credential'}` : undefined;
}
