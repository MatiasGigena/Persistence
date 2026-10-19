import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantMessageEventStream, createProvider, parseStreamingJson } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';

// Claude through the unmodified official `claude` CLI in print mode, signed in with the user's own login
// (docs/models.md, ADR 0010). Claude only proposes tool calls: Pi's tools are listed by a stub MCP server that runs
// nothing, the CLI is stopped at the end of the model's message, and the Pi Harness executes the calls durably.

export const CLAUDE_CLI = 'claude-cli';
const API = 'claude-cli';
const PREFIX = 'mcp__pi__';
const STUB = fileURLToPath(new URL('./claude-cli-mcp.ts', import.meta.url));
const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const STOP = { end_turn: 'stop', stop_sequence: 'stop', refusal: 'stop', tool_use: 'toolUse', max_tokens: 'length',
  model_context_window_exceeded: 'length' };
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

const MODEL = { api: API, provider: CLAUDE_CLI, baseUrl: 'local:claude', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
  thinkingLevelMap: { off: null, minimal: 'low' } };
/** The CLI's own aliases, so each one follows the CLI to the latest model of its family. */
export const MODELS = [
  { id: 'opus', name: 'Claude Opus 5.5 (Claude Code)' },
  { id: 'sonnet', name: 'Claude Sonnet 5.5 (Claude Code)' },
  { id: 'haiku', name: 'Claude Haiku 5.5 (Claude Code)' },
  { id: 'fable', name: 'Claude Fable 5.1 (Claude Code)' },
].map(model => ({ ...MODEL, ...model }));

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function childEnv(env) {
  const out = { ...env };
  for (const name of PARENT_SESSION_ENV) delete out[name];
  return out;
}

const textOf = content => typeof content === 'string' ? content
  : content.map(b => b.type === 'text' ? b.text : `[image: ${b.mimeType}, not shown]`).join('\n');
const attr = value => JSON.stringify(String(value));

function renderMessage(m) {
  if (m.role === 'user') return `<user>\n${textOf(m.content)}\n</user>`;
  if (m.role === 'toolResult') {
    return `<tool_result id=${attr(m.toolCallId)} name=${attr(m.toolName)} is_error="${Boolean(m.isError)}">\n${textOf(m.content)}\n</tool_result>`;
  }
  // Thinking stays out: it is the model's own and cannot be replayed through a text prompt.
  return m.content.map(b => b.type === 'text' ? (b.text ? `<assistant>\n${b.text}\n</assistant>` : '')
    : b.type === 'toolCall' ? `<tool_call id=${attr(b.id)} name=${attr(b.name)}>${JSON.stringify(b.arguments ?? {})}</tool_call>` : '')
    .filter(Boolean).join('\n');
}

/**
 * The one user prompt for a request: the context's messages folded into a tagged transcript (see CONVENTION),
 * then the latest user message as is. A lone user message is sent unchanged.
 */
export function renderPrompt(messages) {
  const body = messages.filter(m => m.role !== 'system');
  const last = body.at(-1)?.role === 'user' ? body.pop() : undefined;
  const history = body.map(renderMessage).filter(Boolean).join('\n\n');
  if (!history) return last ? textOf(last.content) : '';
  return `<transcript>\n${history}\n</transcript>\n\n${last ? textOf(last.content) : 'Continue from the last tool result.'}`;
}

/** argv for one request: `systemFile` holds the system prompt; `toolsFile`, when given, the stub's tool list. */
export function claudeArgs(model, { systemFile, toolsFile, reasoning }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--setting-sources', '', '--settings', SETTINGS, '--model', model.id, '--max-turns', '1',
    '--system-prompt-file', systemFile];
  if (toolsFile) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { pi: { type: 'stdio', command: process.execPath, args: [STUB, toolsFile] } } }));
  }
  if (EFFORT[reasoning]) args.push('--effort', EFFORT[reasoning]);
  return args;
}

function limitMessage(info) {
  const at = info.resetsAt ? ` · resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
  // "quota exceeded" keeps pi-ai's retry policy from retrying a limit that lasts hours.
  return `Claude usage limit reached (${info.rateLimitType ?? 'plan'} quota exceeded)${at}`;
}

/** Translates the CLI's stream-json lines into pi-ai events on `stream`; `finish` ends the request once. */
function createParser(stream, output, finish) {
  let blocks = new Map(); // API block index -> { index, json } for the current API message
  let toolUse = false;
  const usage = u => {
    if (!u) return;
    const o = output.usage;
    if (u.input_tokens !== undefined) o.input = u.input_tokens;
    if (u.cache_read_input_tokens !== undefined) o.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens !== undefined) o.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens !== undefined) o.output = u.output_tokens;
    o.totalTokens = o.input + o.output + o.cacheRead + o.cacheWrite;
  };
  const push = (type, contentIndex, extra = {}) => stream.push({ type, contentIndex, ...extra, partial: output });

  function onStreamEvent(e) {
    if (e.type === 'message_start') {
      blocks = new Map();
      output.responseId = e.message?.id;
      usage(e.message?.usage);
    } else if (e.type === 'content_block_start') {
      const b = e.content_block ?? {};
      const index = output.content.length;
      if (b.type === 'text') {
        output.content.push({ type: 'text', text: '' });
        push('text_start', index);
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        output.content.push({ type: 'thinking', thinking: '', ...(b.type === 'redacted_thinking' ? { redacted: true } : {}) });
        push('thinking_start', index);
      } else if (b.type === 'tool_use') {
        toolUse = true;
        if (!b.name?.startsWith(PREFIX)) return; // not one of Pi's tools: nothing here can run it
        output.content.push({ type: 'toolCall', id: b.id, name: b.name.slice(PREFIX.length), arguments: {} });
        push('toolcall_start', index);
      } else return;
      blocks.set(e.index, { index, json: '' });
    } else if (e.type === 'content_block_delta') {
      const at = blocks.get(e.index);
      if (!at) return;
      const block = output.content[at.index], d = e.delta ?? {};
      if (d.type === 'text_delta') {
        block.text += d.text;
        push('text_delta', at.index, { delta: d.text });
      } else if (d.type === 'thinking_delta') {
        block.thinking += d.thinking;
        push('thinking_delta', at.index, { delta: d.thinking });
      } else if (d.type === 'signature_delta') block.thinkingSignature = (block.thinkingSignature ?? '') + d.signature;
      else if (d.type === 'input_json_delta') {
        at.json += d.partial_json;
        block.arguments = parseStreamingJson(at.json);
        push('toolcall_delta', at.index, { delta: d.partial_json });
      }
    } else if (e.type === 'content_block_stop') {
      const at = blocks.get(e.index);
      if (!at) return;
      blocks.delete(e.index);
      const block = output.content[at.index];
      if (block.type === 'text') push('text_end', at.index, { content: block.text });
      else if (block.type === 'thinking') push('thinking_end', at.index, { content: block.thinking });
      else {
        try { block.arguments = at.json.trim() ? JSON.parse(at.json) : {}; } catch {
          block.arguments = {};
          block.argumentsError = `Tool arguments are not valid JSON: ${at.json}`;
        }
        push('toolcall_end', at.index, { toolCall: block });
      }
    } else if (e.type === 'message_delta') {
      if (e.delta?.stop_reason) output.rawStopReason = e.delta.stop_reason;
      usage(e.usage);
    } else if (e.type === 'message_stop') {
      // The message is complete. Stopping here keeps the CLI from acting on it (denying the tool calls, continuing
      // after max_tokens); --max-turns 1 is the backstop.
      finish({ stopReason: toolUse ? 'toolUse' : STOP[output.rawStopReason] ?? 'stop' });
    }
  }

  return line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'stream_event') onStreamEvent(event.event ?? {});
    else if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
      finish({ error: limitMessage(event.rate_limit_info) });
    } else if (event.type === 'system' && event.subtype === 'api_retry' && event.error === 'authentication_failed') {
      finish({ error: 'claude-cli: Claude Code is not signed in or its login expired (401). Run `claude`, then /login (or `claude auth login`).' });
    } else if (event.type === 'result') {
      if (event.is_error) {
        const detail = typeof event.result === 'string' && event.result ? event.result : (event.errors ?? []).join('; ');
        finish({ error: `claude-cli: ${event.api_error_status ? `API error ${event.api_error_status}: ` : ''}${detail || event.subtype || 'request failed'}` });
      } else {
        usage(event.usage);
        if (!output.content.length && typeof event.result === 'string' && event.result) {
          output.content.push({ type: 'text', text: event.result });
        }
        finish({ stopReason: toolUse ? 'toolUse' : STOP[event.stop_reason] ?? 'stop' });
      }
    }
  };
}

function streamClaude(model, context, options = {}, { bin, env }) {
  const stream = createAssistantMessageEventStream();
  const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now() };
  let child, dir, done = false, stderr = '', timer;
  const signal = options.signal;

  const finish = ({ stopReason, error, aborted }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5_000).unref();
    }
    if (aborted || error) {
      output.stopReason = aborted ? 'aborted' : 'error';
      output.errorMessage = aborted ? 'Request was aborted' : error;
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } else {
      output.stopReason = stopReason;
      stream.push({ type: 'done', reason: stopReason, message: output });
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
      child = spawn(bin, claudeArgs(model, { systemFile, toolsFile, reasoning: options.reasoning }),
        { cwd: dir, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
      const parse = createParser(stream, output, finish);
      let buffer = '';
      child.stdout.setEncoding('utf8').on('data', chunk => {
        buffer += chunk;
        let nl;
        while (!done && (nl = buffer.indexOf('\n')) >= 0) {
          parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => finish({ error: error.code === 'ENOENT'
        ? `claude-cli: ${bin} not found. Install Claude Code or set PI_DURABLE_CLAUDE_BIN.` : `claude-cli: ${error.message}` }));
      child.on('close', (code, sig) => {
        if (buffer.trim()) parse(buffer);
        finish({ error: `claude-cli: claude exited (${sig ?? `status ${code}`}) without a reply${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}` });
      });
      child.stdin.on('error', () => {}); // a CLI that exits early closes its stdin; close reports why
      // The prompt goes on stdin, not argv, so its length is not limited by the OS.
      child.stdin.end(renderPrompt(messages));
    } catch (error) {
      finish({ error: `claude-cli: ${error.message}` });
    }
  });
  return stream;
}

/** `claude auth status` as JSON, or undefined when the CLI is missing, fails, or takes over `timeoutMs`. */
export function claudeAuthStatus({ bin, env, timeoutMs = 10_000 }) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(bin, ['auth', 'status', '--json'], { cwd: tmpdir(), env: childEnv(env), stdio: ['ignore', 'pipe', 'ignore'] });
    // Not spawn's `timeout`: its timer outlives a binary that never started.
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const settle = value => { clearTimeout(timer); resolve(value); };
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.on('error', () => settle(undefined));
    child.on('close', () => {
      try { settle(JSON.parse(out)); } catch { settle(undefined); }
    });
  });
}

/**
 * The `claude-cli` pi-ai provider. `bin` defaults to PI_DURABLE_CLAUDE_BIN, else `claude` on PATH. The environment
 * passes through (an ANTHROPIC_API_KEY there makes the CLI bill that key instead of the plan), minus the markers of
 * a parent Claude Code session.
 */
export function claudeCliProvider({ env = process.env, bin = env.PI_DURABLE_CLAUDE_BIN || 'claude', statusTimeoutMs } = {}) {
  let status; // one `claude auth status` serves the checks of one moment (ModelRuntime runs several at once)
  const check = async () => {
    status ??= claudeAuthStatus({ bin, env, timeoutMs: statusTimeoutMs })
      .finally(() => setTimeout(() => { status = undefined; }, 5_000).unref());
    const result = await status;
    return result?.loggedIn ? { type: 'api_key', source: `claude CLI (${result.authMethod ?? 'signed in'})` } : undefined;
  };
  const stream = (model, context, options) => streamClaude(model, context, options, { bin, env });
  return createProvider({
    id: CLAUDE_CLI,
    name: 'Claude Code CLI',
    // Credentials stay inside the CLI: requests carry no auth of ours, and the check asks the CLI.
    auth: { apiKey: { name: 'Claude Code login', resolve: async () => ({ auth: {}, source: 'claude CLI' }), check } },
    models: MODELS,
    api: { stream, streamSimple: stream },
  });
}
