import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';

/**
 * The standing agents' roster and tool kits (ADR 0027): plain data, with no runtime import, so the CLI's settings
 * parser (src/host/config.ts) uses it without loading pi-durable. src/agents/index.ts re-exports it.
 */

/** The tool kits a standing agent may name; persisted in settings.json, so frozen. */
export const KITS = ['coding', 'read', 'browser', 'web_fetch', 'autoreview'] as const;
export type Kit = typeof KITS[number];
export const isKit = (value: unknown): value is Kit => KITS.some(kit => kit === value);
/** The kits that touch local files: `--no-tools` and `/tools off` remove them; `browser` and `web_fetch` stay. */
export const LOCAL_KITS: readonly Kit[] = ['coding', 'read', 'autoreview'];

/** An agent name: a letter first, since zoom() reads an id of digits as a message id; never "Pi". Lookups ignore case. */
export const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const isAgentName = (name: string): boolean => AGENT_NAME.test(name) && name.toLowerCase() !== 'pi';

/** One roster entry, resolved: settings.json's `"agents": { Name: … }` with `thinkingLevel` defaulted. */
export interface StandingAgent {
  readonly model: ModelRef;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly tools: readonly Kit[];
  /** Added to its role text. */
  readonly instructions?: string;
  /** Its sub agents' model and effort; without them, subs take the standing agent's own. */
  readonly subModel?: ModelRef;
  readonly subThinkingLevel?: ModelThinkingLevel;
}
/** Standing agents by name. */
export type Roster = Readonly<Record<string, StandingAgent>>;

/** The built-in roster, used when settings.json has no `agents` key. */
export const DEFAULT_ROSTER: Roster = {
  Coder: { model: { provider: 'claude-cli', modelId: 'opus' }, thinkingLevel: 'medium', tools: ['coding'] },
  Reviewer: { model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, thinkingLevel: 'xhigh', tools: ['read', 'browser', 'autoreview'] },
  Researcher: { model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, thinkingLevel: 'high', tools: ['web_fetch'] },
};

/**
 * The review kit's policy applies to every session and its subs, even with custom roster instructions. The skill is
 * installed separately (docs/operations.md#autoreview); without it the tool reports the review incomplete.
 */
export const AUTOREVIEW_POLICY = 'For every code review, read the installed /autoreview skill at '
  + '~/.pi/agent/skills/autoreview/SKILL.md (or under PI_CODING_AGENT_DIR when configured), then call the autoreview tool. '
  + 'Always review P0–P2 (--max-priority P2), never only P0 or P1. Choose the Git target explicitly and supply relevant '
  + 'unchanged source/evidence when the diff is insufficient. Codex first; Pi is only a fallback after diagnosing and '
  + 'reporting a concrete Codex availability failure. Never bypass isolation or validation, or switch engines because of '
  + 'slow progress, rate limits, safety refusals or findings. Verify findings against the code before reporting them. '
  + 'Do not substitute a manual review or claim clean when the tool is off, missing, filtered, failed or incomplete; '
  + 'report the blocker instead. Debugging and browser checks do not replace the required code review.';

/** What the built-in standing agents are for, as Pi's role text names them. */
export const PURPOSES: Readonly<Record<string, string>> = {
  Coder: 'programming',
  Reviewer: 'reviewing code through /autoreview at P0–P2, and debugging with a browser',
  Researcher: 'web research',
};
