import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('SIGTERM closes an open stdin producer and releases the launcher', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-shutdown-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const child = spawn(resolve('bin/pi-durable'), ['--database', join(folder, 'session.sqlite'),
    '--model', 'openai/gpt-4o-mini', '--auth-file', join(folder, 'auth.json')], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OPENAI_API_KEY: 'offline-placeholder-not-a-real-key',
      NODE_OPTIONS: `--import=${new URL('../fixtures/stdin-ready.ts', import.meta.url).href}` },
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdin readiness timeout: ${stderr}`)), 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('STDIN_READY')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`early exit ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(child.kill('SIGTERM'), true);
  const result = await exited;
  assert.equal(result.code, 143, stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(stderr, /Closing failed/);
});
