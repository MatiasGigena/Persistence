import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { OutputBuffer, PROGRESS_BYTES_PER_SECOND } from '@earendil-works/chord/output';
import { createModels, validateToolArguments } from '@earendil-works/pi-ai';
import { statePaths } from '../host/config.ts';
import { bwrapBinary, GuardedEnv, protection } from '../runtime/guard.ts';
import type { Protection } from '../runtime/guard.ts';
import { clientConfigPath } from './config.ts';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { jsonData, machineCall, machineTarget, machineToolResult } from '../protocol/machines.ts';
import type { JsonData, MachineCall, MachineToolResult } from '../protocol/machines.ts';
import { LIMITS } from '../protocol/messages.ts';
import type { MachineTarget } from '../protocol/machines.ts';
import { errorCode, errorMessage } from '../protocol/util.ts';

export interface MachineExecutorOptions {
  readonly target: MachineTarget;
  readonly ledgerDir: string;
  readonly enabled?: boolean;
  /** Additional hidden paths; cannot remove the default state/credential protections. */
  readonly protectedPaths?: readonly string[];
  /** The socket of Pi's own SSH agent on this machine (ADR 0030): bash's only SSH_AUTH_SOCK. */
  readonly sshAgent?: string | undefined;
  /** Launch environment for protection paths, upstream protection overrides and bubblewrap selection. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam only; production always invokes native tools through GuardedEnv. */
  readonly execute?: (call: MachineCall, signal: AbortSignal) => Promise<MachineToolResult>;
}

function failure(code: string, message: string): MachineToolResult {
  return { isError: true, output: [{ type: 'text', text: message }], diagnostics: [{ severity: 'error', code, message }] };
}
function canonical(value: JsonData): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`).join(',')}}`;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function fingerprint(call: MachineCall): string {
  // A changed display label is not a changed execution target.
  return hash(canonical({ machineId: call.target.machineId, cwd: call.target.cwd, name: call.name, args: call.args }));
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function ensureDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === path) return;
  await ensureDirectory(parent);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    if (!(await stat(path)).isDirectory()) throw new Error('Ledger path is not a directory');
  }
  // Also flush a concurrently created directory's entry, not only our own mkdir.
  await syncDirectory(parent);
}
async function writeSynced(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}
function bounded(id: string, result: MachineToolResult): MachineToolResult {
  const encoded = JSON.stringify({ t: 'machine.result', id, result });
  // Also bound UTF-8 bytes: the protocol measures code units, but transports may bound bytes.
  return encoded.length <= LIMITS.clientMessage && Buffer.byteLength(encoded) <= LIMITS.clientMessage
    ? result : failure('RESULT_TOO_LARGE', 'Tool result exceeded the protocol limit; output was discarded. Do not repeat this execution.');
}
function unsupported(): never { throw new Error('Durable conversation/document operations are unavailable on an execution machine'); }

function machineProtection(ledgerDir: string, env: NodeJS.ProcessEnv, extra: readonly string[], sshAgent: string | undefined): Protection {
  const home = homedir();
  const dataDir = resolve(env.PI_DURABLE_DATA_DIR ?? join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'pi-durable'));
  const databasePath = join(dataDir, 'chat.sqlite');
  const paths = statePaths(databasePath, env);
  // Derive names only: do not resolve chat configuration, read settings/credentials, or create local chat state.
  const defaults = protection({ dataDir, databasePath, memoryDir: paths.memoryDir, settingsPath: paths.settings,
    serveDir: paths.serveDir, socketPath: paths.socket, authFile: join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'auth.json') }, env, home);
  return { hidden: [...new Set([...defaults.hidden, ledgerDir, dirname(clientConfigPath(env)), ...extra].map(path => resolve(path)))],
    readOnly: defaults.readOnly, sshAgent };
}

/** Invoke the installed CodingTools themselves, including their argument repair and validation. */
async function executeNative(call: MachineCall, signal: AbortSignal, guarded: Protection, bwrap: string): Promise<MachineToolResult> {
  const tool: ToolRegistration | undefined = CodingTools.tools?.find(each => each.name === call.name);
  if (!tool) throw new Error('Unknown machine tool');
  const prepared = jsonData(tool.prepareArguments?.(call.args) ?? call.args);
  if (prepared === null || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Invalid tool arguments');
  const args: unknown = validateToolArguments(tool, { type: 'toolCall', id: call.id, name: call.name, arguments: prepared });
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const env = new GuardedEnv({ cwd: call.target.cwd, protection: guarded, bwrap });
  const limits = { maxBytes: tool.outputLimits?.maxBytes ?? 50 * 1024, maxLines: tool.outputLimits?.maxLines ?? 2000,
    retain: tool.outputLimits?.retain ?? 'head' };
  const output = new OutputBuffer(limits);
  const diagnostics: ToolDiagnostic[] = [];
  let details: JsonData | undefined;
  // No catalog, credentials, or network calls. Unknown remote model capabilities are text-only.
  const models = { ...createModels(), getModel: () => ({
    id: 'machine-text', name: 'Unknown remote model', provider: 'machine', api: 'machine', baseUrl: '',
    input: ['text' as const], reasoning: false, contextWindow: 0, maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }) };
  const api: ToolExecutionApi = {
    get taskId() { return unsupported(); }, get conversationId() { return unsupported(); },
    get registry() { return unsupported(); }, callId: call.id, models, env, now: () => Date.now(),
    agent: () => Promise.resolve({ model: { provider: 'machine', modelId: 'machine-text' }, thinkingLevel: 'off',
      extensions: [], tools: [], callable: [], deferred: [], sections: [], cwd: call.target.cwd }),
    output: (chunk, skipped) => { output.push(chunk, skipped); },
    outputWindow: limits.retain === 'tail' ? { maxBytes: limits.maxBytes, maxLines: limits.maxLines, minIntervalMs: 100, bytesPerSecond: PROGRESS_BYTES_PER_SECOND } : undefined,
    retainedOutput: () => { const snapshot = output.snapshot(); return { text: snapshot.text, truncated: snapshot.droppedBytes > 0 }; },
    diagnostic: diagnostic => { diagnostics.push(diagnostic); },
    details: value => { details = value; return Promise.resolve(); },
    commit: unsupported, memo: unsupported, createTask: unsupported, getTask: unsupported, waitForTask: unsupported,
    conversation: unsupported, executeTool: unsupported, snapshot: unsupported, snapshotAsOf: unsupported, watchDoc: unsupported,
  };
  let result: ToolExecutionResult;
  try {
    signal.throwIfAborted();
    // The installed schema validator has established the registration's erased argument type.
    result = await tool.execute(args, api, context);
  } catch (error) {
    result = { isError: true, diagnostics: [{ severity: 'error', code: signal.aborted ? 'CANCELLED' : 'tool_error', message: errorMessage(error) }] };
  } finally {
    output.end();
    await env.cleanup(BACKGROUND_CONTEXT);
  }
  const retained = output.snapshot();
  if (result.output === undefined && retained.droppedBytes > 0) {
    diagnostics.push({ severity: 'warn', code: 'truncated', message: 'Tool output was truncated to its retained window.' });
  }
  return machineToolResult({ ...result,
    output: result.output ?? (retained.text ? [{ type: 'text', text: retained.text }] : []),
    ...(result.details === undefined && details !== undefined ? { details } : {}),
    diagnostics: [...diagnostics, ...result.diagnostics ?? []],
  });
}

/** A local, crash-fail-closed ledger. cwd pins routing, not a project sandbox; GuardedEnv
 * hides state/credentials and keeps system paths read-only. Disconnects never cancel work.
 */
export class MachineExecutor {
  private readonly target: MachineTarget;
  private readonly ledgerDir: string;
  private readonly runner: NonNullable<MachineExecutorOptions['execute']>;
  private enabled: boolean;
  private closed = false;
  /** The ledger directory made and its path flushed: once per executor, not once per call. */
  private ledgerReady: Promise<void> | undefined;
  private readonly live = new Map<string, { fingerprint: string; controller: AbortController; promise: Promise<MachineToolResult> }>();

  constructor(options: MachineExecutorOptions) {
    this.target = machineTarget(options.target);
    this.ledgerDir = resolve(options.ledgerDir);
    this.enabled = options.enabled === true;
    const env = { ...options.env ?? process.env };
    const guarded = machineProtection(this.ledgerDir, env, options.protectedPaths ?? [], options.sshAgent);
    const bwrap = bwrapBinary(env);
    this.runner = options.execute ?? ((call, signal) => executeNative(call, signal, guarded, bwrap));
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  execute(input: MachineCall): Promise<MachineToolResult> {
    let call: MachineCall;
    try { call = machineCall(input); }
    catch (error) { return Promise.resolve(failure('INVALID_CALL', errorMessage(error))); }
    if (call.target.machineId !== this.target.machineId || call.target.cwd !== this.target.cwd) {
      return Promise.resolve(failure('TARGET_NOT_APPROVED', 'Execution target does not match the approved machine and launch directory.'));
    }
    const digest = fingerprint(call);
    const existing = this.live.get(call.id);
    if (existing) return existing.fingerprint === digest ? existing.promise
      : Promise.resolve(failure('PAYLOAD_MISMATCH', 'Execution id was reused with a changed payload.'));
    if (this.closed) return Promise.resolve(failure('CLOSED', 'Machine executor is closed.'));
    if (!this.enabled) {
      return Promise.resolve(failure('TOOLS_DISABLED', `Machine tools are off on ${this.target.label}. Only the user there can turn them on, with /tools on in that terminal.`));
    }
    const controller = new AbortController();
    const promise = this.run(call, digest, controller.signal).finally(() => { this.live.delete(call.id); });
    this.live.set(call.id, { fingerprint: digest, controller, promise });
    return promise;
  }

  cancel(id: string): void { this.live.get(id)?.controller.abort(new Error('Execution explicitly cancelled')); }

  /** Stop admitting work, but finish and durably cache already admitted calls. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.values()].map(each => each.promise));
  }

  private ensureLedger(): Promise<void> {
    this.ledgerReady ??= ensureDirectory(this.ledgerDir).catch((error: unknown) => {
      this.ledgerReady = undefined;
      throw error;
    });
    return this.ledgerReady;
  }

  private async run(call: MachineCall, digest: string, signal: AbortSignal): Promise<MachineToolResult> {
    const directory = join(this.ledgerDir, hash(call.id));
    /** Whether this call made its entry; false when an earlier one did. */
    const makeEntry = async (): Promise<boolean> => {
      try { await mkdir(directory, { mode: 0o700 }); return true; }
      catch (error) { if (errorCode(error) === 'EEXIST') return false; throw error; }
    };
    try {
      await this.ensureLedger();
      let created: boolean;
      try { created = await makeEntry(); }
      catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        // The ledger was removed since this executor made it: make it again.
        this.ledgerReady = undefined;
        await this.ensureLedger();
        created = await makeEntry();
      }
      if (!created) return await this.previous(directory, digest, call.id);
      // The entry's name and the intent inside it flush together; both are durable before the tool starts.
      await Promise.all([syncDirectory(this.ledgerDir),
        writeSynced(join(directory, 'intent.json'), { version: 1, fingerprint: digest, call }).then(() => syncDirectory(directory))]);
      // No tool (including an injected runner) can start before all of the above is durable.
      let result: MachineToolResult;
      try {
        signal.throwIfAborted();
        result = !this.enabled ? failure('TOOLS_DISABLED', 'Machine tools were disabled before execution.')
          : machineToolResult(await this.runner(call, signal));
      } catch (error) { result = failure(signal.aborted ? 'CANCELLED' : 'EXECUTION_FAILED', errorMessage(error)); }
      result = bounded(call.id, result);
      await writeSynced(join(directory, 'result.tmp'), { fingerprint: digest, result });
      await rename(join(directory, 'result.tmp'), join(directory, 'result.json'));
      await syncDirectory(directory);
      return result;
    } catch (error) {
      return failure('INDETERMINATE', `Execution ledger could not establish a durable outcome; never automatically rerun this id or repeat the operation under a new id. Inspect possible side effects and ask the user before retrying: ${errorMessage(error).slice(0, 1024)}`);
    }
  }

  private async previous(directory: string, digest: string, id: string): Promise<MachineToolResult> {
    const intent: unknown = JSON.parse(await readFile(join(directory, 'intent.json'), 'utf8'));
    if (typeof intent !== 'object' || intent === null || !('fingerprint' in intent) || typeof intent.fingerprint !== 'string') {
      throw new Error('Invalid execution intent');
    }
    if (intent.fingerprint !== digest) return failure('PAYLOAD_MISMATCH', 'Execution id was reused with a changed payload.');
    const path = join(directory, 'result.json');
    if ((await stat(path)).size > LIMITS.clientMessage + 1024) throw new Error('Oversized cached result');
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof saved !== 'object' || saved === null || !('fingerprint' in saved) || saved.fingerprint !== digest || !('result' in saved)) {
      throw new Error('Invalid cached execution result');
    }
    return bounded(id, machineToolResult(saved.result));
  }
}
