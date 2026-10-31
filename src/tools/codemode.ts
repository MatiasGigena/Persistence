import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import type { CodemodeSandboxBase } from '@earendil-works/pi-codemode';
import { hook, ToolTask } from '@earendil-works/pi-durable';
import type { Extension, ToolHookCall, ToolRegistration, Wrap } from '@earendil-works/pi-durable';
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from '@earendil-works/pi-durable/codemode';

/**
 * Code mode (ADR 0033): the `codemode` tool runs a model-written JavaScript script in a QuickJS sandbox
 * (`@earendil-works/pi-codemode`, a worker thread per script) whose only capability is calling the conversation's
 * tools as `await tools.<name>(args)`. Each call is a nested tool call through the Harness: it resolves among the
 * conversation's enabled tools when it runs, and runs their hooks, their GuardedEnv or machine routing, and their own
 * `/tools` checks. pi-durable journals the script, so it survives a restart. No `models.*`: scripts start no model calls.
 */

/** Persisted names (ADR 0033): never rename. pi-durable owns the tool name and its `pi.codemode.*` documents. */
export const CODEMODE_EXTENSION = 'codemode';
export { CODEMODE_TOOL_NAME };

/**
 * The tools a script may call: the coding tools and the read-only memory and agent tools. The others (spawning,
 * delegating, messaging, stopping and deleting agents, show_image, the browser, web_fetch, autoreview) stay the model's.
 */
export const SCRIPT_TOOLS: readonly string[] = ['read', 'write', 'edit', 'bash', 'zoom', 'date', 'list_agents', 'last_message'];

/** QuickJS heap per script; allocations beyond it fail inside the script as out of memory. */
export const CODEMODE_MEMORY_LIMIT = 256 * 1024 * 1024;

export type CodemodeExtension = Extension & { readonly tools: readonly ToolRegistration[] };

export interface Codemode {
  readonly extension: CodemodeExtension;
  /** Aborts running scripts (the next launch replays them) and refuses new ones. */
  close(): Promise<void>;
}

/** Why a script may not make `call`, or undefined. Only nested calls (`call.parent`) are scripts' calls. */
export function scriptRefusal(call: Pick<ToolHookCall, 'name' | 'parent'>): string | undefined {
  if (call.parent === undefined || SCRIPT_TOOLS.includes(call.name)) return undefined;
  return `Tool ${call.name} cannot be called from a code mode script; call it directly.`;
}

/**
 * The code mode extension with its own sandbox (tests may pass one). `others` names the host's other tools: where
 * code mode is selected they become callable by the model only, so scripts neither see nor call them. A guard refuses
 * any nested call outside SCRIPT_TOOLS too, for a tool `others` missed.
 */
export function createCodemode({ sandbox = new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT }), others = [],
  allowed = () => true }: { sandbox?: CodemodeSandboxBase; others?: readonly string[]; allowed?: () => boolean } = {}): Codemode {
  const base = createCodemodeExtension({ sandbox, models: false });
  if (base.name !== CODEMODE_EXTENSION) throw new Error(`pi-durable renamed the code mode extension to ${base.name}.`);
  const guard = hook(ToolTask, {
    beforeTool: (call) => {
      // Launch permission first: /tools off stops a running script's next call before the tool list changes.
      if (call.parent !== undefined && !allowed()) return { block: 'Coding tools are off for this launch.' };
      const refused = scriptRefusal(call);
      return refused === undefined ? undefined : { block: refused };
    },
  });
  const wraps: Wrap[] = [...new Set(others)].filter(name => !SCRIPT_TOOLS.includes(name) && name !== CODEMODE_TOOL_NAME)
    .map(name => ({ tool: name, wrap: (tool: ToolRegistration) => ({ ...tool, callers: ['model'] as const }) }));
  return {
    // The section lists what scripts can call; without the tool offered (tools off, standing agents) it says nothing.
    extension: { ...base, tools: base.tools ?? [], sections: (base.sections ?? []).map(each => ({ ...each,
      render: (input, context) => input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME) ? each.render(input, context) : undefined })),
    hooks: [...base.hooks ?? [], guard], wraps: [...base.wraps ?? [], ...wraps] },
    close: () => sandbox.close(),
  };
}
