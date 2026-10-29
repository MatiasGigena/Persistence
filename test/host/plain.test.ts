import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

// util-linux `script` gives the launcher a terminal, so --plain chat reads lines. No message is sent: no network.
test('--plain chat explains the terminal UI commands it lacks, and names an unknown one', { timeout: 20000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-plain-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const launch = [resolve('bin/pi-durable'), '--plain', '--no-tools', '--database', join(folder, 'chat.sqlite'),
    '--model', 'openai/gpt-4o-mini', '--auth-file', join(folder, 'auth.json')].map(quote).join(' ');
  const child = spawn('script', ['-qfec', launch, '/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OPENAI_API_KEY: 'offline-placeholder-not-a-real-key',
      PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json'), PI_DURABLE_REMOTE: '' },
  });
  t.after(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const until = async (pattern: RegExp): Promise<void> => {
    for (const end = Date.now() + 10_000; !pattern.test(output);) {
      if (Date.now() > end || child.exitCode !== null) assert.fail(`no ${String(pattern)} in: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await until(/you> /);
  for (const line of ['/model x/y', '/thinking low', '/tools on', '/mem', '/stop', '/frob 1']) child.stdin.write(`${line}\r`);
  await until(/Unknown command \/frob\. Use \/help\./);
  assert.match(output, /\/model is in the terminal UI only; here, relaunch with --model PROVIDER\/ID\./);
  assert.match(output, /\/thinking is in the terminal UI only; here, relaunch with --thinking LEVEL\./);
  assert.match(output, /\/tools is in the terminal UI only; here, relaunch with or without --no-tools\./);
  assert.match(output, /\/mem is in the terminal UI only; here, run --status for the memory counters\./);
  assert.match(output, /\/stop is in the terminal UI only; here, Ctrl\+C closes the host/);
  child.stdin.write('/exit\r');
  assert.equal(await exited, 0, output);
});
