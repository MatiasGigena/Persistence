import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import type { CodemodeSandboxBase } from '@earendil-works/pi-codemode';
import { hook, ToolTask } from '@earendil-works/pi-durable';
import type { Extension, ToolHookCall, ToolRegistration, Wrap } from '@earendil-works/pi-durable';
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { err, FileError } from '@earendil-works/pi-durable/env';
import type { ExecutionEnv, Result } from '@earendil-works/pi-durable/env';
import type { Context } from '@earendil-works/chord';
import type { ConversationId } from '@earendil-works/pi-durable';
import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from '@earendil-works/pi-codemode/source';
import { isRecord } from '../protocol/util.ts';

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

/**
 * A script's deadline when it sets no `timeout_ms`. pi-durable persists a deadline only for a script that sets one, and
 * its sandbox runs a script without one with no limit, so every script gets this one (`withDefaultTimeout`).
 */
export const CODEMODE_TIMEOUT_MS = 300_000;

/**
 * `source` with `timeout_ms` set in its options line when it sets none: pi-durable then persists the deadline, so it
 * bounds the script across restarts too. Deterministic, so a replay of the same arguments gets the same deadline
 * rule. A source that does not parse is returned as is, for pi-durable to report.
 */
export function withDefaultTimeout(source: string, timeoutMs = CODEMODE_TIMEOUT_MS): string {
  let parsed: ReturnType<typeof parseCodemodeSource>;
  try { parsed = parseCodemodeSource(source); } catch { return source; }
  if (parsed.options.timeoutMs !== undefined) return source;
  const options = { ...parsed.options.maxOutputTokens === undefined ? {} : { max_output_tokens: parsed.options.maxOutputTokens },
    timeout_ms: timeoutMs };
  const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(options)}`;
  // With an options line, `code` starts at its newline; without one, the script follows the new line unchanged.
  return (source.split('\n')[0] ?? '').trimStart().startsWith(CODEMODE_OPTIONS_PREFIX) ? line + parsed.code : `${line}\n${source}`;
}

/**
 * The environment pi-durable writes a script's output files with (a truncated result's full text, its images) when
 * they may not be saved: both writes it makes fail with `reason`, so the result says so instead of naming a path.
 */
function refusingOutput(base: ExecutionEnv, reason: string): ExecutionEnv {
  const refused = <T>(): Promise<Result<T, FileError>> => Promise.resolve(err(new FileError('not_supported', reason)));
  // pi-durable's code mode writes output files (outputFiles, outputDir) through these two; everything else is `base`'s.
  // Members are bound one by one, not spread or inherited, so a class env keeps its private state and tsc checks that
  // none is missing.
  return {
    get id() { return base.id; },
    get cwd() { return base.cwd; },
    set cwd(cwd: string) { base.cwd = cwd; },
    absolutePath: base.absolutePath.bind(base), joinPath: base.joinPath.bind(base),
    readTextFile: base.readTextFile.bind(base), openTextLineReader: base.openTextLineReader.bind(base),
    readTextLines: base.readTextLines.bind(base), readBinaryFile: base.readBinaryFile.bind(base),
    openBinaryReader: base.openBinaryReader.bind(base), appendFile: base.appendFile.bind(base),
    truncateFile: base.truncateFile.bind(base), flushFile: base.flushFile.bind(base), renameFile: base.renameFile.bind(base),
    fileInfo: base.fileInfo.bind(base), listDir: base.listDir.bind(base),
    ...base.listFiles ? { listFiles: base.listFiles.bind(base) } : {},
    openDirReader: base.openDirReader.bind(base), watch: base.watch.bind(base), canonicalPath: base.canonicalPath.bind(base),
    exists: base.exists.bind(base), createDir: base.createDir.bind(base), remove: base.remove.bind(base),
    createTempFile: base.createTempFile.bind(base), exec: base.exec.bind(base), cleanup: base.cleanup.bind(base),
    createTempDir: refused<string>, writeFile: refused<void>,
  };
}

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
  allowed = () => true, timeoutMs = CODEMODE_TIMEOUT_MS, outputRefusal }: {
  sandbox?: CodemodeSandboxBase; others?: readonly string[]; allowed?: () => boolean;
  /** Default deadline of a script that sets none; tests shorten it. */
  timeoutMs?: number;
  /**
   * Why a call's output files may not be saved, or undefined: on a remote destination the server's temp directory
   * is not what the remote `read` reads, so no path is returned for it.
   */
  outputRefusal?: (conversationId: ConversationId, context: Context) => Promise<string | undefined>;
} = {}): Codemode {
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
    extension: { ...base, tools: (base.tools ?? []).map(tool => tool.name !== CODEMODE_TOOL_NAME ? tool : { ...tool,
      async execute(args, api, context) {
        // The tool's own validation refuses arguments without code.
        if (!isRecord(args) || typeof args.code !== 'string') return tool.execute(args, api, context);
        const code = withDefaultTimeout(args.code, timeoutMs);
        // Without an env, code mode writes no output files at all (it says so itself).
        const refused = await outputRefusal?.(api.conversationId, context);
        return tool.execute({ ...args, code }, refused === undefined || !api.env ? api : { ...api, env: refusingOutput(api.env, refused) }, context);
      } }), sections: (base.sections ?? []).map(each => ({ ...each,
      render: (input, context) => input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME) ? each.render(input, context) : undefined })),
    hooks: [...base.hooks ?? [], guard], wraps: [...base.wraps ?? [], ...wraps] },
    close: () => sandbox.close(),
  };
}
