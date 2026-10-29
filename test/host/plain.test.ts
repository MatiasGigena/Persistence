import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { TestContext } from 'node:test';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** Scripted fake `claude` replies (test/fixtures/fake-claude.ts), one per call: a text answer each. */
function replies(texts: readonly string[]): unknown[] {
  const ev = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
  return texts.map(text => ({ exit: 0, lines: [
    { type: 'system', subtype: 'init', tools: [], model: 'claude-haiku-5-5' },
    ev({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    ev({ type: 'message_stop' }),
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text,
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 },
  ] }));
}

/**
 * The launcher in --plain chat on a fresh chat in `folder`, under util-linux `script` so it reads lines from a
 * terminal. `until` waits for a pattern in its output so far.
 */
function plainChat(t: TestContext, folder: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const launch = [resolve('bin/pi-durable'), '--plain', '--no-tools', '--database', join(folder, 'chat.sqlite'),
    '--auth-file', join(folder, 'auth.json'), ...args].map(quote).join(' ');
  const child = spawn('script', ['-qfec', launch, '/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json'), PI_DURABLE_REMOTE: '', ...env },
  });
  t.after(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const chat = { output: '', child, exited: new Promise<number | null>(resolve => child.once('exit', resolve)),
    async until(pattern: RegExp): Promise<void> {
      for (const end = Date.now() + 10_000; !pattern.test(chat.output);) {
        if (Date.now() > end || child.exitCode !== null) assert.fail(`no ${String(pattern)} in: ${chat.output}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } };
  child.stdout.on('data', chunk => { chat.output += String(chunk); });
  return chat;
}

async function tempFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-plain-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// No message is sent: no network.
test('--plain chat explains the terminal UI commands it lacks, and names an unknown one', { timeout: 20000 }, async t => {
  const chat = plainChat(t, await tempFolder(t), ['--model', 'openai/gpt-4o-mini'],
    { OPENAI_API_KEY: 'offline-placeholder-not-a-real-key' });
  await chat.until(/you> /);
  for (const line of ['/model x/y', '/thinking low', '/tools on', '/mem', '/stop', '/frob 1']) chat.child.stdin.write(`${line}\r`);
  await chat.until(/Unknown command \/frob\. Use \/help\./);
  assert.match(chat.output, /\/model is in the terminal UI only; here, relaunch with --model PROVIDER\/ID\./);
  assert.match(chat.output, /\/thinking is in the terminal UI only; here, relaunch with --thinking LEVEL\./);
  assert.match(chat.output, /\/tools is in the terminal UI only; here, relaunch with or without --no-tools\./);
  assert.match(chat.output, /\/mem is in the terminal UI only; here, run --status for the memory counters\./);
  assert.match(chat.output, /\/stop is in the terminal UI only; here, Ctrl\+C closes the host/);
  chat.child.stdin.write('/exit\r');
  assert.equal(await chat.exited, 0, chat.output);
});

test('--plain chat prints Pi\'s reply, then one prompt', { timeout: 20000 }, async t => {
  const folder = await tempFolder(t);
  const bin = join(folder, 'claude'), script = join(folder, 'script.json'), log = join(folder, 'calls.jsonl');
  await writeFile(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`, { mode: 0o755 });
  // Spare replies for the memory's summaries.
  await writeFile(script, JSON.stringify(replies(['first answer', 'second answer', ...Array<string>(8).fill('summary')])));
  await writeFile(log, '');
  const chat = plainChat(t, folder, ['--model', 'claude-cli/haiku'], { PI_DURABLE_CLAUDE_BIN: bin,
    FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_AUTH: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  await chat.until(/you> /);
  chat.child.stdin.write('hello\r');
  await chat.until(/pi> first answer/);
  chat.child.stdin.write('again\r');
  await chat.until(/pi> second answer/);
  chat.child.stdin.write('/exit\r');
  assert.equal(await chat.exited, 0, chat.output);
  const shown = stripVTControlCharacters(chat.output).replaceAll('\r', '');
  assert.doesNotMatch(shown, /you> you> /, shown);
  assert.match(shown, /pi> first answer\n\nyou> again\n/, shown);
});
