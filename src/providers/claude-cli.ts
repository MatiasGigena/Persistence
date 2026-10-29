import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream, createProvider, parseStreamingJson } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, AuthCheck, ImageContent, JsonObject,
  Message, Model, Provider, SimpleStreamOptions, SystemMessage, TextContent, ThinkingLevel, TranscriptContext,
  Usage } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';

// Claude through the unmodified official `claude` CLI in print mode, signed in with the user's own login
// (docs/models.md, ADR 0010). Claude only proposes tool calls: Pi's tools are listed by a stub MCP server that runs
// nothing, the CLI is stopped at the end of the model's message, and the Pi Harness executes the calls durably.

export const CLAUDE_CLI = 'claude-cli';
const API = 'claude-cli';
const PREFIX = 'mcp__pi__';
const STUB = fileURLToPath(new URL('./claude-cli-mcp.ts', import.meta.url));
const EFFORT: Record<ThinkingLevel, string> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
// A request whose CLI prints nothing for this long is stuck: it is stopped with a retryable error.
const IDLE_TIMEOUT_MS = 10 * 60_000;
type Done = Extract<AssistantMessageEvent, { type: 'done' }>['reason'];
const STOP: Partial<Record<string, Done>> = { end_turn: 'stop', stop_sequence: 'stop', refusal: 'stop', tool_use: 'toolUse',
  max_tokens: 'length', model_context_window_exceeded: 'length' };
// Markers a parent Claude Code session exports to its children; this CLI call is a fresh, separate session.
const PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN'];
// `--setting-sources ''` skips user and project settings and CLAUDE.md files; these close what it leaves on.
const SETTINGS = JSON.stringify({ autoMemoryEnabled: false, disableAllHooks: true });
export const CONVENTION = [
  'Transcript convention: earlier turns of this conversation may appear in the user message as tagged blocks:',
  '<user>, <assistant>, <tool_call id name> (a tool call you made, with its JSON arguments) and',
  '<tool_result id name is_error> (what that call returned). They are history and already done.',
  'To use a tool now, call it through the provided tools. Never write these tags yourself.',
].join('\n');

export type ClaudeCliModel = Model<typeof API>;
const MODEL: Omit<ClaudeCliModel, 'id' | 'name'> = { api: API, provider: CLAUDE_CLI, baseUrl: 'local:claude', reasoning: true,
  input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
  thinkingLevelMap: { off: null, minimal: 'low', xhigh: 'xhigh', max: 'max' } };
/** The CLI's own aliases, so each one follows the CLI to the latest model of its family. */
export const MODELS: readonly ClaudeCliModel[] = [
  { id: 'opus', name: 'Claude Opus 5.5 (Claude Code)' },
  { id: 'sonnet', name: 'Claude Sonnet 5.5 (Claude Code)' },
  { id: 'haiku', name: 'Claude Haiku 5.5 (Claude Code)' },
  { id: 'fable', name: 'Claude Fable 5.1 (Claude Code)' },
].map(model => ({ ...MODEL, ...model }));

// The stream-json lines of `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, as far as
// this provider reads them. Lines are parsed as unknown and narrowed below; anything else is ignored.

/** Token counts of the Anthropic Messages API. */
interface ApiUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number }
type ApiContentBlock = { type: 'text' } | { type: 'thinking' } | { type: 'redacted_thinking' }
  | { type: 'tool_use'; id: string; name: string };
type ApiDelta = { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string } | { type: 'input_json_delta'; partial_json: string };
/** The raw Anthropic streaming events a `stream_event` line carries. */
type ApiStreamEvent =
  | { type: 'message_start'; message?: { id?: string; usage?: ApiUsage } }
  | { type: 'content_block_start'; index: number; content_block?: ApiContentBlock }
  | { type: 'content_block_delta'; index: number; delta?: ApiDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: ApiUsage }
  | { type: 'message_stop' };
interface RateLimitInfo { status?: string; resetsAt?: number; rateLimitType?: string }
/** One line of the CLI's own stream. */
type CliEvent =
  | { type: 'system'; subtype: 'init'; model?: string }
  | { type: 'system'; subtype: 'api_retry'; error?: string }
  | { type: 'stream_event'; event?: ApiStreamEvent }
  | { type: 'assistant'; message: unknown }
  | { type: 'rate_limit_event'; rate_limit_info?: RateLimitInfo }
  | { type: 'result'; subtype?: string; is_error: boolean; result?: string; errors?: string[]; api_error_status?: number;
    stop_reason?: string; usage?: ApiUsage };

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
// JSON.parse yields JSON values only, so a parsed object is a JsonObject.
const isJsonObject = (value: unknown): value is JsonObject => isJson(value);
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' ? value : undefined;
const parseJson = (text: string): unknown => JSON.parse(text);

function parseUsage(value: unknown): ApiUsage | undefined {
  if (!isJson(value)) return undefined;
  return { input_tokens: num(value.input_tokens), output_tokens: num(value.output_tokens),
    cache_read_input_tokens: num(value.cache_read_input_tokens), cache_creation_input_tokens: num(value.cache_creation_input_tokens) };
}

function parseBlock(value: unknown): ApiContentBlock | undefined {
  if (!isJson(value)) return undefined;
  const { type } = value;
  if (type === 'text' || type === 'thinking' || type === 'redacted_thinking') return { type };
  if (type === 'tool_use') return { type, id: str(value.id) ?? '', name: str(value.name) ?? '' };
  return undefined;
}

function parseDelta(value: unknown): ApiDelta | undefined {
  if (!isJson(value)) return undefined;
  const { type } = value;
  if (type === 'text_delta' && typeof value.text === 'string') return { type, text: value.text };
  if (type === 'thinking_delta' && typeof value.thinking === 'string') return { type, thinking: value.thinking };
  if (type === 'signature_delta' && typeof value.signature === 'string') return { type, signature: value.signature };
  if (type === 'input_json_delta' && typeof value.partial_json === 'string') return { type, partial_json: value.partial_json };
  return undefined;
}

function parseStreamEvent(value: unknown): ApiStreamEvent | undefined {
  if (!isJson(value)) return undefined;
  const { type } = value, index = num(value.index);
  if (type === 'message_start') {
    const message = isJson(value.message) ? { id: str(value.message.id), usage: parseUsage(value.message.usage) } : undefined;
    return { type, message };
  }
  if (type === 'content_block_start' && index !== undefined) return { type, index, content_block: parseBlock(value.content_block) };
  if (type === 'content_block_delta' && index !== undefined) return { type, index, delta: parseDelta(value.delta) };
  if (type === 'content_block_stop' && index !== undefined) return { type, index };
  if (type === 'message_delta') {
    return { type, delta: isJson(value.delta) ? { stop_reason: str(value.delta.stop_reason) } : undefined, usage: parseUsage(value.usage) };
  }
  if (type === 'message_stop') return { type };
  return undefined;
}

function parseCliEvent(value: unknown): CliEvent | undefined {
  if (!isJson(value)) return undefined;
  const { type } = value;
  if (type === 'system') {
    if (value.subtype === 'init') return { type, subtype: 'init', model: str(value.model) };
    if (value.subtype === 'api_retry') return { type, subtype: 'api_retry', error: str(value.error) };
    return undefined;
  }
  if (type === 'stream_event') return { type, event: parseStreamEvent(value.event) };
  if (type === 'assistant') return { type, message: value.message };
  if (type === 'rate_limit_event') {
    const info = value.rate_limit_info;
    return { type, rate_limit_info: isJson(info)
      ? { status: str(info.status), resetsAt: num(info.resetsAt), rateLimitType: str(info.rateLimitType) } : undefined };
  }
  if (type === 'result') {
    return { type, subtype: str(value.subtype), is_error: Boolean(value.is_error), result: str(value.result),
      errors: isList(value.errors) ? value.errors.filter(e => typeof e === 'string') : undefined,
      api_error_status: num(value.api_error_status), stop_reason: str(value.stop_reason), usage: parseUsage(value.usage) };
  }
  return undefined;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of PARENT_SESSION_ENV) delete out[name];
  return out;
}

const textOf = (content: string | (TextContent | ImageContent)[]) => typeof content === 'string' ? content
  : content.map(b => b.type === 'text' ? b.text : `[image: ${b.mimeType}, not shown]`).join('\n');
/** The text of the latest user message alone: its images go with the prompt as image blocks (see renderInput). */
const textOnly = (content: string | (TextContent | ImageContent)[]) => typeof content === 'string' ? content
  : content.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
const attr = (value: string) => JSON.stringify(String(value));

type Turn = Exclude<Message, SystemMessage>;

function renderMessage(m: Turn): string {
  if (m.role === 'user') return `<user>\n${textOf(m.content)}\n</user>`;
  if (m.role === 'toolResult') {
    return `<tool_result id=${attr(m.toolCallId)} name=${attr(m.toolName)} is_error="${Boolean(m.isError)}">\n${textOf(m.content)}\n</tool_result>`;
  }
  // Thinking stays out: it is the model's own and cannot be replayed through a text prompt.
  return m.content.map(b => b.type === 'text' ? (b.text ? `<assistant>\n${b.text}\n</assistant>` : '')
    : b.type === 'toolCall' ? `<tool_call id=${attr(b.id)} name=${attr(b.name)}>${JSON.stringify(b.arguments ?? {})}</tool_call>` : '')
    .filter(Boolean).join('\n');
}

/** The context's turns, and the latest user message split off when the context ends with one. */
function split(messages: readonly Message[]) {
  const body = messages.filter((m): m is Turn => m.role !== 'system');
  const tail = body.at(-1);
  const last = tail?.role === 'user' ? tail : undefined;
  if (last) body.pop();
  return { body, last };
}

/**
 * The text of the one user prompt for a request: the context's messages folded into a tagged transcript (see
 * CONVENTION), then the latest user message's text. A lone user message is sent unchanged. Images in history become
 * `[image: <type>, not shown]`; the latest user message's images go as image blocks instead (renderInput).
 */
export function renderPrompt(messages: readonly Message[]): string {
  const { body, last } = split(messages);
  const history = body.map(renderMessage).filter(Boolean).join('\n\n');
  if (!history) return last ? textOnly(last.content) : '';
  return `<transcript>\n${history}\n</transcript>\n\n${last ? textOnly(last.content) : 'Continue from the last tool result.'}`;
}

/**
 * The stdin of a request (`--input-format stream-json`): one user message line whose content is the latest user
 * message's images, as Anthropic base64 image blocks, then the prompt text (renderPrompt).
 */
export function renderInput(messages: readonly Message[]): string {
  const { last } = split(messages);
  const images = typeof last?.content === 'string' ? [] : (last?.content ?? []).flatMap(b => b.type === 'image'
    ? [{ type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } }] : []);
  const text = renderPrompt(messages);
  const content = [...images, ...text || !images.length ? [{ type: 'text', text }] : []];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

export interface ClaudeArgsOptions {
  /** Holds the system prompt. */
  systemFile: string;
  /** Holds the stub MCP server's tool list; without it Claude gets no tools. */
  toolsFile?: string;
  reasoning?: ThinkingLevel;
}

/** argv for one request: `systemFile` holds the system prompt; `toolsFile`, when given, the stub's tool list. */
export function claudeArgs(model: Pick<Model<Api>, 'id'>, { systemFile, toolsFile, reasoning }: ClaudeArgsOptions): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--setting-sources', '', '--settings', SETTINGS, '--model', model.id, '--max-turns', '1',
    '--system-prompt-file', systemFile,
    // Opus omits its thinking by default, which leaves minutes of silence on screen; summaries stream instead.
    '--thinking-display', 'summarized'];
  if (toolsFile) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { pi: { type: 'stdio', command: process.execPath, args: [STUB, toolsFile] } } }));
  }
  if (reasoning) args.push('--effort', EFFORT[reasoning]);
  return args;
}

function limitMessage(info: RateLimitInfo): string {
  const at = info.resetsAt ? ` · resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
  // "quota exceeded" keeps pi-ai's retry policy from retrying a limit that lasts hours.
  return `Claude usage limit reached (${info.rateLimitType ?? 'plan'} quota exceeded)${at}`;
}

/** How a request ends: a stop reason, an error message, or an abort. */
type Ending = { stopReason: Done } | { error: string } | { aborted: true };
/** A block event without its `partial`, which `push` adds. */
type BlockEvent = Exclude<AssistantMessageEvent, { type: 'start' | 'done' | 'error' }>;
type WithoutPartial<T> = T extends unknown ? Omit<T, 'partial'> : never;

/**
 * Translates the CLI's stream-json lines into pi-ai events on `stream`; `finish` ends the request once. `piTools` are
 * the names of the tools this request offered.
 */
function createParser(stream: AssistantMessageEventStream, output: AssistantMessage, finish: (ending: Ending) => void,
  piTools: ReadonlySet<string>) {
  let blocks = new Map<number, { index: number; json: string }>(); // API block index -> output block, current API message
  let toolUse = false;
  const foreign: string[] = []; // tool_use blocks naming a tool that is not Pi's
  const usage = (u: ApiUsage | undefined) => {
    if (!u) return;
    const o = output.usage;
    if (u.input_tokens !== undefined) o.input = u.input_tokens;
    if (u.cache_read_input_tokens !== undefined) o.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens !== undefined) o.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens !== undefined) o.output = u.output_tokens;
    o.totalTokens = o.input + o.output + o.cacheRead + o.cacheWrite;
  };
  const push = (event: WithoutPartial<BlockEvent>) => stream.push({ ...event, partial: output });
  const stopOf = (raw: string | undefined): Done => toolUse ? 'toolUse' : (raw === undefined ? undefined : STOP[raw]) ?? 'stop';
  /**
   * The end of a complete message. A turn that only called tools Pi does not have would end as an empty answer, with
   * nothing on screen; it is an error instead.
   */
  const end = (raw: string | undefined) => !toolUse && foreign.length
    ? finish({ error: `claude-cli: Claude called ${foreign.join(', ')}, which ${foreign.length > 1 ? 'are' : 'is'} not one of Pi's tools` })
    : finish({ stopReason: stopOf(raw) });

  function onStreamEvent(e: ApiStreamEvent) {
    if (e.type === 'message_start') {
      blocks = new Map();
      output.responseId = e.message?.id;
      usage(e.message?.usage);
    } else if (e.type === 'content_block_start') {
      const b = e.content_block;
      const index = output.content.length;
      if (b?.type === 'text') {
        output.content.push({ type: 'text', text: '' });
        push({ type: 'text_start', contentIndex: index });
      } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        output.content.push({ type: 'thinking', thinking: '', ...(b.type === 'redacted_thinking' ? { redacted: true } : {}) });
        push({ type: 'thinking_start', contentIndex: index });
      } else if (b?.type === 'tool_use') {
        // Pi's tools are offered as mcp__pi__<name>, but Claude sometimes calls one by its bare name, as the transcript
        // writes it: that is still Pi's tool. Any other name is not: nothing here can run it.
        const name = b.name.startsWith(PREFIX) ? b.name.slice(PREFIX.length) : piTools.has(b.name) ? b.name : undefined;
        if (name === undefined) { foreign.push(b.name); return; }
        toolUse = true;
        output.content.push({ type: 'toolCall', id: b.id, name, arguments: {} });
        push({ type: 'toolcall_start', contentIndex: index });
      } else return;
      blocks.set(e.index, { index, json: '' });
    } else if (e.type === 'content_block_delta') {
      const at = blocks.get(e.index);
      const block = at && output.content[at.index], d = e.delta;
      if (!at || !block || !d) return;
      if (d.type === 'text_delta' && block.type === 'text') {
        block.text += d.text;
        push({ type: 'text_delta', contentIndex: at.index, delta: d.text });
      } else if (d.type === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += d.thinking;
        push({ type: 'thinking_delta', contentIndex: at.index, delta: d.thinking });
      } else if (d.type === 'signature_delta' && block.type === 'thinking') {
        block.thinkingSignature = (block.thinkingSignature ?? '') + d.signature;
      } else if (d.type === 'input_json_delta' && block.type === 'toolCall') {
        at.json += d.partial_json;
        block.arguments = parseStreamingJson<JsonObject>(at.json);
        push({ type: 'toolcall_delta', contentIndex: at.index, delta: d.partial_json });
      }
    } else if (e.type === 'content_block_stop') {
      const at = blocks.get(e.index);
      const block = at && output.content[at.index];
      if (!at || !block) return;
      blocks.delete(e.index);
      if (block.type === 'text') push({ type: 'text_end', contentIndex: at.index, content: block.text });
      else if (block.type === 'thinking') push({ type: 'thinking_end', contentIndex: at.index, content: block.thinking });
      else {
        let args: unknown;
        try { args = at.json.trim() ? parseJson(at.json) : {}; } catch { args = undefined; }
        if (isJsonObject(args)) block.arguments = args;
        else {
          block.arguments = {};
          block.argumentsError = `Tool arguments are not valid JSON: ${at.json}`;
        }
        push({ type: 'toolcall_end', contentIndex: at.index, toolCall: block });
      }
    } else if (e.type === 'message_delta') {
      if (e.delta?.stop_reason) output.rawStopReason = e.delta.stop_reason;
      usage(e.usage);
    } else {
      // message_stop: the message is complete. Stopping here keeps the CLI from acting on it (denying the tool calls,
      // continuing after max_tokens); --max-turns 1 is the backstop.
      end(output.rawStopReason);
    }
  }

  return (line: string) => {
    let event: CliEvent | undefined;
    try { event = parseCliEvent(parseJson(line)); } catch { return; }
    if (event?.type === 'stream_event') {
      if (event.event) onStreamEvent(event.event);
    } else if (event?.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
      finish({ error: limitMessage(event.rate_limit_info) });
    } else if (event?.type === 'system' && event.subtype === 'api_retry' && event.error === 'authentication_failed') {
      finish({ error: 'claude-cli: Claude Code is not signed in or its login expired (401). Run `claude`, then /login (or `claude auth login`).' });
    } else if (event?.type === 'result') {
      if (event.is_error) {
        const detail = event.result || (event.errors ?? []).join('; ');
        finish({ error: `claude-cli: ${event.api_error_status ? `API error ${event.api_error_status}: ` : ''}${detail || event.subtype || 'request failed'}` });
      } else {
        usage(event.usage);
        if (!output.content.length && event.result) output.content.push({ type: 'text', text: event.result });
        end(event.stop_reason);
      }
    }
  };
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>;
interface Cli { bin: string; env: NodeJS.ProcessEnv; idleTimeoutMs: number }

function streamClaude(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}, { bin, env, idleTimeoutMs }: Cli) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now() };
  let child: Child | undefined, dir: string | undefined, done = false, stderr = '', timer: NodeJS.Timeout | undefined;
  let idle: NodeJS.Timeout | undefined;
  // "timed out" keeps the error retryable: the Harness tries again, and shows that it does.
  const watch = () => {
    clearTimeout(idle);
    if (done) return; // a CLI being stopped may still print; no timer may outlive the request
    const span = idleTimeoutMs < 1000 ? `${idleTimeoutMs} ms` : `${Math.round(idleTimeoutMs / 1000)} s`;
    idle = setTimeout(() => finish({ error: `claude-cli: no output from claude for ${span} (timed out)` }), idleTimeoutMs);
  };
  const signal = options.signal;

  const finish = (ending: Ending) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
    const running = child;
    if (running && running.exitCode === null && running.signalCode === null) {
      running.kill('SIGTERM');
      setTimeout(() => { if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL'); }, 5_000).unref();
    }
    if ('stopReason' in ending) {
      output.stopReason = ending.stopReason;
      stream.push({ type: 'done', reason: ending.stopReason, message: output });
    } else {
      const reason = 'aborted' in ending ? 'aborted' : 'error';
      output.stopReason = reason;
      output.errorMessage = 'aborted' in ending ? 'Request was aborted' : ending.error;
      stream.push({ type: 'error', reason, error: output });
    }
    stream.end(output);
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const onAbort = () => finish({ aborted: true });

  queueMicrotask(async () => {
    try {
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => finish({ error: `claude-cli: timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
      const { messages } = context;
      // The compactor sends toolChoice "none": then Claude gets no tools at all.
      const tools = options.toolChoice === 'none' ? [] : getCurrentTools(messages);
      // A private empty working directory, so no project files or settings around it apply.
      const made = await mkdtemp(join(tmpdir(), 'pi-durable-claude-'));
      if (done) return void rm(made, { recursive: true, force: true }).catch(() => {});
      dir = made;
      const systemFile = join(dir, 'system.md');
      const toolsFile = tools.length ? join(dir, 'tools.json') : undefined;
      await writeFile(systemFile, [getCurrentSystemPrompt(messages), CONVENTION].filter(Boolean).join('\n\n'));
      if (toolsFile) await writeFile(toolsFile, JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
      if (done) return;
      stream.push({ type: 'start', partial: output });
      const proc: Child = spawn(bin, claudeArgs(model, { systemFile, toolsFile, reasoning: options.reasoning }),
        { cwd: dir, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
      child = proc;
      const parse = createParser(stream, output, finish, new Set(tools.map(tool => tool.name)));
      let buffer = '';
      watch();
      proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        watch();
        buffer += chunk;
        let nl;
        while (!done && (nl = buffer.indexOf('\n')) >= 0) {
          parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      proc.on('error', error => finish({ error: 'code' in error && error.code === 'ENOENT'
        ? `claude-cli: ${bin} not found. Install Claude Code or set PI_DURABLE_CLAUDE_BIN.` : `claude-cli: ${error.message}` }));
      proc.on('close', (code, sig) => {
        if (buffer.trim()) parse(buffer);
        const last = stderr.trim().split('\n').at(-1) ?? '';
        // An option this provider passes that the CLI does not know (--thinking-display, say) means an old CLI.
        const old = /unknown option/i.test(last) ? '. This Claude Code is too old for pi-durable: update it (claude update).' : '';
        finish({ error: `claude-cli: claude exited (${sig ?? `status ${code}`}) without a reply${last ? `: ${last}` : ''}${old}` });
      });
      proc.stdin.on('error', () => {}); // a CLI that exits early closes its stdin; close reports why
      // The prompt goes on stdin, not argv, so its length is not limited by the OS; stream-json carries its images.
      proc.stdin.end(renderInput(messages));
    } catch (error) {
      finish({ error: `claude-cli: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
  return stream;
}

/** What `claude auth status --json` reports, as far as the provider reads it. */
export interface ClaudeAuthStatus { loggedIn: boolean; authMethod?: string }
export interface ClaudeAuthStatusOptions { bin: string; env: NodeJS.ProcessEnv; timeoutMs?: number }

/** `claude auth status` as JSON, or undefined when the CLI is missing, fails, or takes over `timeoutMs`. */
export function claudeAuthStatus({ bin, env, timeoutMs = 10_000 }: ClaudeAuthStatusOptions): Promise<ClaudeAuthStatus | undefined> {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(bin, ['auth', 'status', '--json'], { cwd: tmpdir(), env: childEnv(env), stdio: ['ignore', 'pipe', 'ignore'] });
    // Not spawn's `timeout`: its timer outlives a binary that never started.
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const settle = (value: ClaudeAuthStatus | undefined) => { clearTimeout(timer); resolve(value); };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => settle(undefined));
    child.on('close', () => {
      let status: unknown;
      try { status = parseJson(out); } catch { return settle(undefined); }
      settle(isJson(status) ? { loggedIn: Boolean(status.loggedIn), authMethod: str(status.authMethod) } : undefined);
    });
  });
}

export interface ClaudeCliProviderOptions {
  /** The environment the CLI runs in; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The `claude` binary; defaults to PI_DURABLE_CLAUDE_BIN in `env`, else `claude` on PATH. */
  bin?: string;
  /** How long `claude auth status` may take; defaults to 10 s. */
  statusTimeoutMs?: number;
  /** How long a request may go without output from the CLI before it fails as timed out; defaults to 10 minutes. */
  idleTimeoutMs?: number;
}

/**
 * The `claude-cli` pi-ai provider. `bin` defaults to PI_DURABLE_CLAUDE_BIN, else `claude` on PATH. The environment
 * passes through (an ANTHROPIC_API_KEY there makes the CLI bill that key instead of the plan), minus the markers of
 * a parent Claude Code session.
 */
export function claudeCliProvider({ env = process.env, bin = env.PI_DURABLE_CLAUDE_BIN || 'claude', statusTimeoutMs,
  idleTimeoutMs = IDLE_TIMEOUT_MS }: ClaudeCliProviderOptions = {}): Provider<typeof API> {
  let status: Promise<ClaudeAuthStatus | undefined> | undefined; // one `claude auth status` serves the checks of one moment (ModelRuntime runs several at once)
  const check = async (): Promise<AuthCheck | undefined> => {
    status ??= claudeAuthStatus({ bin, env, timeoutMs: statusTimeoutMs })
      .finally(() => setTimeout(() => { status = undefined; }, 5_000).unref());
    const result = await status;
    return result?.loggedIn ? { type: 'api_key', source: `claude CLI (${result.authMethod ?? 'signed in'})` } : undefined;
  };
  const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => streamClaude(model, context, options, { bin, env, idleTimeoutMs });
  return createProvider({
    id: CLAUDE_CLI,
    name: 'Claude Code CLI',
    // Credentials stay inside the CLI: requests carry no auth of ours, and the check asks the CLI.
    auth: { apiKey: { name: 'Claude Code login', resolve: async () => ({ auth: {}, source: 'claude CLI' }), check } },
    models: MODELS,
    api: { stream, streamSimple: stream },
  });
}
