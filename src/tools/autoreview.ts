import { defineTool } from '@earendil-works/pi-durable';
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { arr, obj, opt, type Static, str, union } from '@earendil-works/pi-schema';
import { literal } from './schema.ts';


const value = str({ minLength: 1 });
const parameters = obj({
  mode: union([literal('local'), literal('branch'), literal('commit')], {
    description: 'local includes staged, unstaged and untracked work; branch compares merge-base to HEAD; commit reviews one commit.',
  }),
  repository: opt(str({ minLength: 1, description: 'Repository directory on the pinned machine; absolute or relative to its working directory. Default: .' })),
  base: opt(str({ minLength: 1, description: 'Required for branch; optional pinned base for local.' })),
  commit: opt(str({ minLength: 1, description: 'Only for commit mode; default HEAD.' })),
  prompt: opt(str({ description: 'Task-specific context; does not expand the selected Git scope.' })),
  promptFiles: opt(arr(value, { description: 'Context files inside the reviewed repository.' })),
  datasets: opt(arr(value, { description: 'Repository-relative evidence files; include unchanged source when needed.' })),
  engine: opt(union([literal('codex'), literal('pi')], {
    description: 'Default codex. Use pi only after diagnosing and reporting a concrete Codex availability failure, never to bypass isolation, safety, rate limits or findings.',
  })),
});

/** Quote one shell argument; no caller text is executable syntax or an extra helper option. */
function quote(text: string): string {
  if (text.includes('\0')) throw new Error('Autoreview arguments cannot contain NUL.');
  return `'${text.replaceAll("'", "'\\''")}'`;
}

type Input = Static<typeof parameters>;

/**
 * Only the installed skill helper is executable; Git scope and context are the entire caller-controlled surface. The
 * skill and its pinned Codex CLI are installed separately on each execution machine: see docs/operations.md#autoreview.
 */
function command(args: Input): string {
  if (!['local', 'branch', 'commit'].includes(args.mode)) throw new Error('Choose local, branch or commit mode.');
  if (args.mode === 'branch' && !args.base) throw new Error('Branch reviews require an explicit base.');
  if (args.mode === 'commit' && args.base !== undefined) throw new Error('Commit reviews do not accept a base.');
  if (args.mode !== 'commit' && args.commit !== undefined) throw new Error('A commit is only valid in commit mode.');
  const engine = args.engine ?? 'codex';
  if (engine !== 'codex' && engine !== 'pi') throw new Error('Only Codex and the Pi availability fallback are supported.');
  const flags = [`--mode=${args.mode}`, `--engine=${engine}`, '--max-priority=P2'];
  for (const [flag, text] of [['base', args.base], ['commit', args.commit], ['prompt', args.prompt]] as const) {
    if (text !== undefined) flags.push(`--${flag}=${text}`);
  }
  for (const path of args.promptFiles ?? []) flags.push(`--prompt-file=${path}`);
  for (const path of args.datasets ?? []) flags.push(`--dataset=${path}`);
  return [
    `cd -- ${quote(args.repository ?? '.')} || exit 2`,
    'skill="${PI_CODING_AGENT_DIR:-${HOME:?}/.pi/agent}/skills/autoreview"',
    'if [ ! -r "$skill/SKILL.md" ] || [ ! -r "$skill/scripts/autoreview" ]; then',
    '  printf "%s\\n" "Autoreview skill is not installed or readable on this execution machine ($skill). Review incomplete." >&2',
    '  exit 2',
    'fi',
  ].join('\n') + '\nexec python3 "$skill/scripts/autoreview" '
    + '--codex-bin="${HOME:?}/.local/share/autoreview/codex-cli/bin/codex" '
    + flags.map(quote).join(' ');
}

/** Persisted names (ADR 0029): never rename. */
export const AUTOREVIEW_EXTENSION = 'autoreview';
export const AUTOREVIEW_TOOL = 'autoreview';

export type AutoreviewExtension = Extension & { readonly tools: readonly ToolRegistration[] };

/** Run through the host's existing guarded/routed bash implementation, without offering bash to the agent. */
export function createAutoreviewExtension(bash: ToolRegistration): AutoreviewExtension {
  const tool = defineTool({
    name: AUTOREVIEW_TOOL,
    description: 'Run the installed /autoreview skill with a fixed P0–P2 threshold. Codex first, with the standalone CLI. '
      + 'Preserves helper isolation, Git capture, validation and exit status. Exit 1 can mean findings, not reviewer unavailability. '
      + 'A failed/incomplete/filtered review is not clean. No general shell, edits, raw flags or isolation overrides.',
    parameters,
    ...(bash.structuredOutputSchema ? { structuredOutputSchema: bash.structuredOutputSchema } : {}),
    // Paid reviewer calls and remote shell executions must not be repeated automatically after a crash.
    replay: 'unsafe',
    outputLimits: { retain: 'tail' },
    execute: (args, api, context) => bash.execute({ command: command(args) }, api, context),
  });
  return { name: AUTOREVIEW_EXTENSION, tools: [tool] };
}
