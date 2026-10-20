import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Context } from '@earendil-works/chord';
import { createModels, getSupportedThinkingLevels, Type } from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantMessageEventStream, AuthCheck, AuthResult, Credential, Models, ThinkingLevel, Tool,
  ToolResultMessage, Usage, UserMessage } from '@earendil-works/pi-ai';
import type { Conversation } from '@earendil-works/pi-durable';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { anthropicSubscriptionSource } from '../../src/providers/anthropic.ts';
import type { AnthropicAuthModels } from '../../src/providers/anthropic.ts';
import { claudeArgs, claudeCliProvider, CONVENTION, MODELS, renderPrompt } from '../../src/providers/claude-cli.ts';
import { answerText, openInstance, transcript } from '../../src/runtime/runtime.ts';
import type { FakeClaudeStep } from '../fixtures/fake-claude.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const STUB = fileURLToPath(new URL('../../src/providers/claude-cli-mcp.ts', import.meta.url));

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const parseJson = (text: string): unknown => JSON.parse(text);
/** The value at `path` inside parsed JSON, or undefined. */
function dig(value: unknown, ...path: (string | number)[]): unknown {
  let at = value;
  for (const key of path) at = isList(at) ? (typeof key === 'number' ? at[key] : undefined) : isJson(at) ? at[key] : undefined;
  return at;
}

// stream-json lines as claude 2.1.303 prints them with --include-partial-messages.
const ev = (event: Json): Json => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
const init = { type: 'system', subtype: 'init', tools: [], model: 'claude-haiku-5-5' };
const start = ev({ type: 'message_start', message: { id: 'msg_1', usage: {
  input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 1 } } });
const text = (index: number, ...parts: string[]) => [
  ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
  ...parts.map(part => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } })),
  ev({ type: 'content_block_stop', index }),
];
const thinking = (index: number, part: string) => [
  ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }),
  ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: part } }),
  ev({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }),
  ev({ type: 'content_block_stop', index }),
];
const toolUse = (index: number, id: string, name: string, input: Json) => {
  const json = JSON.stringify(input), half = Math.floor(json.length / 2);
  return [
    ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: `mcp__pi__${name}`, input: {} } }),
    ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } }),
    ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } }),
    ev({ type: 'content_block_stop', index }),
  ];
};
const end = (stop_reason: string) => [ev({ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5 } }), ev({ type: 'message_stop' })];
const result = (extra: Json) => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '',
  usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, ...extra });
const reply = (...parts: string[]): FakeClaudeStep => ({ lines: [init, start, ...text(0, ...parts), ...end('end_turn'), result({ result: parts.join('') })], exit: 0 });

/** What the fake CLI logged for one call (see test/fixtures/fake-claude.ts); a SIGTERM logs `killed` alone. */
interface Call { argv: string[]; stdin: string; cwd: string; env: unknown; system: string | null; mcp: unknown; tools: unknown[];
  killed: boolean }

function parseCall(line: string): Call {
  const value = parseJson(line), o: Json = isJson(value) ? value : {};
  return { argv: isList(o.argv) ? o.argv.filter(isString) : [], stdin: isString(o.stdin) ? o.stdin : '',
    cwd: isString(o.cwd) ? o.cwd : '', env: o.env, system: isString(o.system) ? o.system : null, mcp: o.mcp,
    tools: isList(o.tools) ? o.tools : [], killed: o.killed === true };
}

/** A provider whose `claude` is the fake CLI playing `script`; `calls()` reads what each call received. */
async function fakeCli(t: TestContext, script: FakeClaudeStep[] = [],
  { auth, env: extra = {}, idleTimeoutMs }: { auth?: Json; env?: NodeJS.ProcessEnv; idleTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-fake-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const log = join(dir, 'calls.jsonl'), scriptFile = join(dir, 'script.json');
  await writeFile(log, '');
  await writeFile(scriptFile, JSON.stringify(script));
  const env = { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCRIPT: scriptFile, CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session', ANTHROPIC_API_KEY: 'sk-ant-api03-user-choice',
    ...(auth ? { FAKE_CLAUDE_AUTH: JSON.stringify(auth) } : {}), ...extra };
  const models = createModels();
  models.setProvider(claudeCliProvider({ env, bin, ...idleTimeoutMs === undefined ? {} : { idleTimeoutMs } }));
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(parseCall);
  const model = models.getModel('claude-cli', 'haiku');
  assert.ok(model);
  return { dir, bin, models, model, calls };
}

async function collect(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, types: events.map(e => e.type), message: await stream.result() };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 3_000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await new Promise(r => setTimeout(r, 20))) {
    if (await predicate()) return true;
  }
  return false;
}

const user = (content: UserMessage['content'], timestamp = 1): UserMessage => ({ role: 'user', content, timestamp });
const firstText = (message: AssistantMessage) => {
  const [block] = message.content;
  return block?.type === 'text' ? block.text : undefined;
};
const noUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tools: Tool[] = [{ name: 'read', description: 'Read a file', parameters: Type.Object({ path: Type.String() }) },
  { name: 'date', description: 'Date of a message', parameters: Type.Object({ id: Type.Integer() }) }];

describe('claude-cli provider (fake claude)', { timeout: 30_000 }, () => {
  test('streams text to a stop, in an isolated fresh call', async (t) => {
    const cli = await fakeCli(t, [reply('Hel', 'lo')]);
    const { types, message } = await collect(cli.models.streamSimple(cli.model,
      { systemPrompt: 'You are Pi.', tools, messages: [user('Hi there')] }, { reasoning: 'high', sessionId: 'ignored' }));
    assert.deepEqual(types, ['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done']);
    assert.equal(message.stopReason, 'stop');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }]);
    assert.deepEqual({ ...message.usage, cost: message.usage.cost.total },
      { input: 10, output: 5, cacheRead: 4, cacheWrite: 2, totalTokens: 21, cost: 0 });
    const [call] = await cli.calls();
    assert.ok(call);
    assert.equal(call.stdin, 'Hi there');
    for (const flag of ['-p', '--verbose', '--include-partial-messages', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) {
      assert.ok(call.argv.includes(flag), flag);
    }
    const value = (flag: string) => call.argv[call.argv.indexOf(flag) + 1];
    assert.equal(value('--output-format'), 'stream-json');
    assert.equal(value('--tools'), '');
    assert.equal(value('--setting-sources'), '');
    assert.deepEqual(parseJson(value('--settings') ?? ''), { autoMemoryEnabled: false, disableAllHooks: true });
    assert.equal(value('--model'), 'haiku');
    assert.equal(value('--max-turns'), '1');
    assert.equal(value('--effort'), 'high');
    assert.equal(value('--thinking-display'), 'summarized');
    assert.ok(!call.argv.some(arg => ['--resume', '--session-id', '--continue', '--bare'].includes(arg)));
    assert.equal(call.system, `You are Pi.\n\n${CONVENTION}`);
    assert.ok(call.cwd.startsWith(tmpdir()) && call.cwd !== process.cwd());
    assert.deepEqual(call.env, { ANTHROPIC_API_KEY: 'sk-ant-api03-user-choice', CLAUDECODE: null,
      CLAUDE_CODE_SESSION_ID: null, HOME: process.env.HOME ?? null });
    assert.ok(await until(() => !existsSync(call.cwd)), 'the private directory is removed');
  });

  test('a tool_use becomes a Pi toolCall, and the CLI is stopped before acting on it', async (t) => {
    const cli = await fakeCli(t, [{ lines: [init, start, ...thinking(0, 'Need the file.'), ...text(1, 'Reading.'),
      ...toolUse(2, 'toolu_1', 'read', { path: 'a.txt' }), ...end('tool_use')] }]);
    const { types, message } = await collect(cli.models.streamSimple(cli.model,
      { systemPrompt: 'S', tools, messages: [user('Read a.txt')] }));
    assert.equal(message.stopReason, 'toolUse');
    assert.deepEqual(message.content, [
      { type: 'thinking', thinking: 'Need the file.', thinkingSignature: 'sig' },
      { type: 'text', text: 'Reading.' },
      { type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: 'a.txt' } },
    ]);
    assert.deepEqual(types.filter(type => type.startsWith('toolcall')), ['toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_end']);
    assert.ok(await until(async () => (await cli.calls()).some(c => c.killed)), 'the CLI was killed');
    const [call] = await cli.calls();
    assert.ok(call);
    assert.deepEqual(dig(call.mcp, 'mcpServers', 'pi', 'command'), process.execPath);
    assert.equal(dig(call.mcp, 'mcpServers', 'pi', 'args', 0), STUB);
    assert.deepEqual(call.tools.map(tool => dig(tool, 'name')), ['read', 'date']);
    assert.equal(dig(call.tools, 0, 'parameters', 'properties', 'path', 'type'), 'string');
  });

  test('parallel tool_use blocks become parallel toolCalls', async (t) => {
    const cli = await fakeCli(t, [{ lines: [init, start, ...toolUse(0, 'toolu_a', 'read', { path: 'a' }),
      ...toolUse(1, 'toolu_b', 'date', { id: 3 }), ...end('tool_use')] }]);
    const { message } = await collect(cli.models.streamSimple(cli.model, { tools, messages: [user('both')] }));
    assert.equal(message.stopReason, 'toolUse');
    assert.deepEqual(message.content.map(b => b.type === 'toolCall' ? [b.id, b.name, b.arguments] : b.type), [['toolu_a', 'read', { path: 'a' }], ['toolu_b', 'date', { id: 3 }]]);
  });

  test('a turn that only calls tools Pi does not have is an error, not an empty answer', async (t) => {
    const foreign = ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'ToolSearch', input: {} } });
    const cli = await fakeCli(t, [
      { lines: [init, start, foreign, ev({ type: 'content_block_stop', index: 0 }), ...end('tool_use')] },
      { lines: [init, start, foreign, ev({ type: 'content_block_stop', index: 0 }), ...toolUse(1, 'toolu_1', 'read', { path: 'a' }), ...end('tool_use')] },
    ]);
    const lone = (await collect(cli.models.streamSimple(cli.model, { tools, messages: [user('x')] }))).message;
    assert.equal(lone.stopReason, 'error');
    assert.equal(lone.errorMessage, 'claude-cli: Claude called ToolSearch, which is not one of Pi\'s tools');
    const mixed = (await collect(cli.models.streamSimple(cli.model, { tools, messages: [user('x')] }))).message;
    assert.equal(mixed.stopReason, 'toolUse', "Pi's own calls still run");
    assert.deepEqual(mixed.content.map(b => b.type === 'toolCall' ? b.name : b.type), ['read']);
  });

  test('a CLI that prints nothing for idleTimeoutMs fails as timed out, so the Harness retries', async (t) => {
    const cli = await fakeCli(t, [{ lines: [init, start, ...text(0, 'partial')] }], { idleTimeoutMs: 300 });
    const { message } = await collect(cli.models.streamSimple(cli.model, { messages: [user('x')] }));
    assert.equal(message.stopReason, 'error');
    assert.equal(message.errorMessage, 'claude-cli: no output from claude for 300 ms (timed out)');
    assert.ok(isRetryableAssistantError(message));
    assert.ok(await until(async () => (await cli.calls()).some(c => c.killed)), 'the CLI was killed');
  });

  test('history is folded into one tagged prompt, tool results included', async (t) => {
    const cli = await fakeCli(t, [reply('It says hi.')]);
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Sure.' },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } }], api: 'claude-cli', provider: 'claude-cli',
    model: 'haiku', usage: noUsage, stopReason: 'toolUse', timestamp: 2 };
    const result: ToolResultMessage = { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'hi' }], isError: false, timestamp: 3 };
    await collect(cli.models.streamSimple(cli.model, { tools, messages: [user('Read a.txt'), assistant, result] }));
    const [call] = await cli.calls();
    assert.ok(call);
    assert.equal(call.stdin, [
      '<transcript>', '<user>\nRead a.txt\n</user>', '', '<assistant>\nSure.\n</assistant>',
      '<tool_call id="t1" name="read">{"path":"a.txt"}</tool_call>', '',
      '<tool_result id="t1" name="read" is_error="false">\nhi\n</tool_result>', '</transcript>', '',
      'Continue from the last tool result.'].join('\n'));
    assert.ok(!call.stdin.includes('secret'));
    const next = renderPrompt([{ role: 'system', content: 'S', timestamp: 0 }, user('a'), { ...assistant, content: [{ type: 'text', text: 'b' }] },
      user([{ type: 'text', text: 'c' }, { type: 'image', mimeType: 'image/png', data: 'AA' }])]);
    assert.equal(next, '<transcript>\n<user>\na\n</user>\n\n<assistant>\nb\n</assistant>\n</transcript>\n\nc\n[image: image/png, not shown]');
  });

  test('toolChoice "none" gives Claude no tools at all', async (t) => {
    const cli = await fakeCli(t, [reply('a line')]);
    const { message } = await collect(cli.models.streamSimple(cli.model, { systemPrompt: 'S', tools, messages: [user('summarize')] },
      { toolChoice: 'none', reasoning: 'low' }));
    assert.equal(firstText(message), 'a line');
    const [call] = await cli.calls();
    assert.ok(call);
    assert.ok(!call.argv.includes('--mcp-config'));
    assert.ok(call.argv.includes('--strict-mcp-config'));
  });

  test('thinking levels map to --effort', () => {
    const [opus] = MODELS;
    assert.ok(opus);
    const effort = (reasoning: ThinkingLevel | undefined) => {
      const args = claudeArgs(opus, { systemFile: 'system.md', reasoning });
      return args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined;
    };
    const levels: (ThinkingLevel | undefined)[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', undefined];
    assert.deepEqual(levels.map(effort),
      ['low', 'low', 'medium', 'high', 'xhigh', 'max', undefined]);
    assert.deepEqual(getSupportedThinkingLevels(opus), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'every effort can be picked');
    assert.deepEqual(MODELS.map(m => m.id), ['opus', 'sonnet', 'haiku', 'fable']);
  });

  test('CLI errors, usage limits, and a lost login end the stream with an error', async (t) => {
    const cli = await fakeCli(t, [
      { lines: [init, { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
        result({ is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' })], exit: 1 },
      { lines: [init, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } }] },
      { lines: [init], stderr: 'boom\nfatal: something broke\n', exit: 2 },
      { lines: [init, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 401, error: 'authentication_failed' }] },
    ]);
    const ask = async () => (await collect(cli.models.streamSimple(cli.model, { messages: [user('x')] }))).message;
    const overloaded = await ask();
    assert.equal(overloaded.stopReason, 'error');
    assert.equal(overloaded.errorMessage, 'claude-cli: API error 529: API Error: 529 Overloaded');
    assert.ok(isRetryableAssistantError(overloaded));
    const limited = await ask();
    assert.match(limited.errorMessage ?? '', /^Claude usage limit reached \(five_hour quota exceeded\) · resets /);
    assert.ok(!isRetryableAssistantError(limited), 'a plan limit lasts hours: no retries');
    const crashed = await ask();
    assert.equal(crashed.errorMessage, 'claude-cli: claude exited (status 2) without a reply: fatal: something broke');
    const signedOut = await ask();
    assert.match(signedOut.errorMessage ?? '', /not signed in.*claude auth login/);
    assert.ok(await until(async () => (await cli.calls()).filter(c => c.killed).length === 2), 'limit and 401 calls were killed');
  });

  test('abort and timeoutMs kill the CLI', async (t) => {
    const cli = await fakeCli(t, [{ lines: [init, start, ...text(0, 'partial')] }, { lines: [init] }]);
    const controller = new AbortController();
    const stream = cli.models.streamSimple(cli.model, { messages: [user('x')] }, { signal: controller.signal });
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === 'text_delta') controller.abort();
    }
    const aborted = await stream.result();
    assert.equal(types.at(-1), 'error');
    assert.equal(aborted.stopReason, 'aborted');
    assert.equal(firstText(aborted), 'partial');
    const timed = (await collect(cli.models.streamSimple(cli.model, { messages: [user('x')] }, { timeoutMs: 300 }))).message;
    assert.equal(timed.stopReason, 'error');
    assert.match(timed.errorMessage ?? '', /timed out after 300 ms/);
    assert.ok(isRetryableAssistantError(timed));
    assert.ok(await until(async () => (await cli.calls()).filter(c => c.killed).length === 2));
  });

  test('auth check asks `claude auth status`, logged in or not', async (t) => {
    const signedIn = await fakeCli(t, [], { auth: { loggedIn: true, authMethod: 'claude.ai' } });
    assert.deepEqual(await signedIn.models.checkAuth('claude-cli'), { type: 'api_key', source: 'claude CLI (claude.ai)' });
    assert.deepEqual((await signedIn.models.getAuth('claude-cli'))?.auth, {});
    const [status] = await signedIn.calls();
    assert.deepEqual(status?.argv, ['auth', 'status', '--json']);
    const signedOut = await fakeCli(t, [], { auth: { loggedIn: false } });
    assert.equal(await signedOut.models.checkAuth('claude-cli'), undefined);
    const missing = createModels();
    missing.setProvider(claudeCliProvider({ bin: join(signedIn.dir, 'no-such-claude') }));
    assert.equal(await missing.checkAuth('claude-cli'), undefined);
  });

  test('through the Harness: Claude proposes a tool, Pi runs it, the next call sees its result', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-claude-e2e-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'note.txt'), 'the note says hi');
    const cli = await fakeCli(t, [
      { lines: [init, start, ...toolUse(0, 'toolu_1', 'read', { path: 'note.txt' }), ...end('tool_use')] },
      reply('The note says hi.'),
    ]);
    // src/runtime is not typed yet: name what this test uses of the instance.
    const instance: { root: Conversation; context: Context; memory?: { jobs: number }; close(): Promise<void> } = await openInstance({
      databasePath: join(cwd, 'state', 'chat.sqlite'), cwd, allowTools: true, models: cli.models,
      model: { provider: 'claude-cli', modelId: 'haiku' }, onReport: undefined });
    try {
      assert.equal(instance.memory?.jobs, 2, 'claude-cli compactions run 2 at a time');
      const submission = await instance.root.submit({ type: 'input', content: 'Read note.txt.' }, instance.context);
      assert.equal(await answerText(instance.root, await submission.wait(instance.context), instance.context), 'The note says hi.');
      const calls = (await cli.calls()).filter(c => c.argv.length);
      assert.equal(calls.length, 2);
      const [first, second] = calls;
      assert.ok(first && second);
      assert.ok(first.tools.some(tool => dig(tool, 'name') === 'read') && first.tools.some(tool => dig(tool, 'name') === 'zoom'));
      assert.match(first.system ?? '', /UniiChat|zoom/);
      assert.ok(second.stdin.includes('<tool_call id="toolu_1" name="read">{"path":"note.txt"}</tool_call>'));
      assert.ok(second.stdin.includes('<tool_result id="toolu_1" name="read" is_error="false">'));
      assert.ok(second.stdin.includes('the note says hi'));
      const entries: unknown[] = await transcript(instance.root, instance.context);
      assert.ok(entries.some(entry => dig(entry, 'kind') === 'pi.tool-result' && JSON.stringify(dig(entry, 'model')).includes('the note says hi')));
    } finally {
      await instance.close();
    }
  });
});

describe('claude-cli stub MCP server', () => {
  test('lists the tools it is given and defers every call', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-durable-mcp-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'tools.json');
    await writeFile(file, JSON.stringify([{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]));
    const child = spawn(process.execPath, [STUB, file], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const call = async (id: number, method: string, params?: Json) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const line = await lines.next();
      if (line.done) throw new Error('the stub closed its output');
      return parseJson(line.value);
    };
    try {
      assert.equal(dig(await call(1, 'initialize', { protocolVersion: '2025-06-18' }), 'result', 'serverInfo', 'name'), 'pi');
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.deepEqual(dig(await call(2, 'tools/list'), 'result', 'tools'), [{ name: 'read', description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]);
      assert.deepEqual(dig(await call(3, 'tools/call', { name: 'read', arguments: { path: 'x' } }), 'result'),
        { content: [{ type: 'text', text: 'deferred to host' }] });
      assert.equal(dig(await call(4, 'resources/list'), 'error', 'code'), -32601);
    } finally {
      child.kill();
    }
  });
});

describe('anthropic subscription refusal', () => {
  const fake = (check: AuthCheck | undefined, auth?: AuthResult): AnthropicAuthModels =>
    ({ checkAuth: async () => check, getAuth: async () => auth });
  const source = async (models: AnthropicAuthModels) => await anthropicSubscriptionSource(models) ?? '';

  test('detects a Claude subscription however it is supplied', async () => {
    assert.match(await source(fake({ type: 'oauth', source: 'OAuth' })), /Pro\/Max login/);
    assert.equal(await anthropicSubscriptionSource(fake({ type: 'api_key', source: 'ANTHROPIC_OAUTH_TOKEN' })), 'ANTHROPIC_OAUTH_TOKEN');
    assert.match(await source(fake({ type: 'api_key', source: 'stored credential' },
      { auth: { apiKey: 'sk-ant-oat01-abc' }, source: 'stored credential' })), /subscription token in stored credential/);
    assert.match(await source(fake({ type: 'api_key', source: 'ANTHROPIC_AUTH_TOKEN' },
      { auth: { headers: { Authorization: 'Bearer sk-ant-oat01-abc' } }, source: 'ANTHROPIC_AUTH_TOKEN' })), /ANTHROPIC_AUTH_TOKEN/);
    assert.equal(await anthropicSubscriptionSource(fake({ type: 'api_key', source: 'ANTHROPIC_API_KEY' },
      { auth: { apiKey: 'sk-ant-api03-abc' }, source: 'ANTHROPIC_API_KEY' })), undefined);
    assert.equal(await anthropicSubscriptionSource(fake(undefined)), undefined);
  });

  test('reads pi-ai\'s real anthropic auth without refreshing an OAuth login', async () => {
    const real = (credential: Credential | undefined, vars: Record<string, string> = {}): Models => {
      const models = createModels({
        credentials: { read: async () => credential, list: async () => [], modify: async () => { throw new Error('no writes'); }, delete: async () => {} },
        authContext: { env: async (name: string) => vars[name], fileExists: async () => false },
      });
      models.setProvider(anthropicProvider());
      return models;
    };
    const expired: Credential = { type: 'oauth', access: 'sk-ant-oat01-x', refresh: 'r', expires: 0 };
    assert.match(await source(real(expired)), /Pro\/Max login/);
    assert.equal(await anthropicSubscriptionSource(real(undefined, { ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-x' })), 'ANTHROPIC_OAUTH_TOKEN');
    assert.match(await source(real(undefined, { ANTHROPIC_API_KEY: 'sk-ant-oat01-x' })), /ANTHROPIC_API_KEY/);
    assert.equal(await anthropicSubscriptionSource(real(undefined, { ANTHROPIC_API_KEY: 'sk-ant-api03-x' })), undefined);
    assert.equal(await anthropicSubscriptionSource(real({ type: 'api_key', key: 'sk-ant-api03-x' })), undefined);
  });
});
