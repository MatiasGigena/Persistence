import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { isRecord, parseArgs, resolveOptions, writeSettings } from '../../src/host/config.ts';
import { openInstance } from '../../src/runtime/runtime.ts';

const exec = promisify(execFile);
const launcher = resolve('bin/pi-durable');

test('parse prompt, explicit tool opt-in, and namespaced model IDs', () => {
  const options = parseArgs(['--allow-tools', '--model', 'openrouter/vendor/model', '-p', 'hello']);
  assert.equal(options.allowTools, true);
  assert.deepEqual(options.model, { provider: 'openrouter', modelId: 'vendor/model' });
  assert.equal(options.prompt, 'hello');
  assert.equal(parseArgs([]).allowTools, false);
  assert.equal(parseArgs(['hello', 'world']).prompt, 'hello world');
  assert.equal(parseArgs(['--', '--literal']).prompt, '--literal');
});

test('the model: --model, else PI_DURABLE_MODEL, else settings.json, else the default', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = join(folder, 'settings.json');
  const launch = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const config = await resolveOptions(parseArgs(['--database', join(folder, 'chat.sqlite'), '--cwd', folder, ...args]), env);
    return [`${config.model.provider}/${config.model.modelId}`, config.modelSource];
  };
  assert.equal(parseArgs([]).model, undefined, 'parseArgs reads no environment');
  assert.deepEqual(await launch([]), ['openai-codex/gpt-6.1-sol', 'default']);
  assert.equal((await resolveOptions(parseArgs(['--database', join(folder, 'chat.sqlite'), '--cwd', folder]), {})).settingsPath, settingsPath);
  writeSettings(settingsPath, { model: { provider: 'claude-cli', modelId: 'sonnet' } });
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.deepEqual(await launch([]), ['claude-cli/sonnet', 'settings']);
  assert.deepEqual(await launch([], { PI_DURABLE_MODEL: 'openrouter/vendor/model' }), ['openrouter/vendor/model', 'env']);
  assert.deepEqual(await launch(['--model', 'anthropic/claude-sonnet-5-5'], { PI_DURABLE_MODEL: 'openai/gpt-4o' }), ['anthropic/claude-sonnet-5-5', 'flag']);
  await assert.rejects(launch([], { PI_DURABLE_MODEL: 'no-provider' }), /PI_DURABLE_MODEL must be PROVIDER\/MODEL_ID/);
  for (const bad of ['{"model":', '{"model":7}', '{"model":"no-provider"}', '[]']) {
    await writeFile(settingsPath, bad);
    await assert.rejects(launch([]), /settings\.json/, bad);
  }
  assert.deepEqual(await launch(['--model', 'claude-cli/haiku']), ['claude-cli/haiku', 'flag'], 'a flag skips the file');
});

test('--plain selects the line chat', () => {
  assert.equal(parseArgs(['--plain']).plain, true);
  assert.equal(parseArgs([]).plain, undefined);
});

test('reject malformed and conflicting CLI inputs', () => {
  for (const args of [['--session', 'named'], ['--model', 'no-provider'], ['--thinking', 'huge'],
    ['--history', '--resume'], ['--status', 'hello'],
    ['--request-id', 'key'], ['--print', ''], ['--bad'], ['--cwd'], ['-p', 'x', 'y']]) {
    assert.throws(() => parseArgs(args), Error, JSON.stringify(args));
  }
});

test('help works without loading runtime/authentication', async () => {
  const { stdout } = await exec(launcher, ['--help']);
  assert.match(stdout, /Tools are OFF/);
  assert.match(stdout, /--allow-tools/);
});

test('inspection of absent state creates no directory', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-path-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const dataDir = join(folder, 'nonexistent');
  const options = await resolveOptions(parseArgs(['--status', '--data-dir', dataDir, '--cwd', folder]));
  assert.equal(options.exists, false);
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
  const { stdout } = await exec(launcher, ['--history', '--data-dir', dataDir, '--cwd', folder]);
  assert.match(stdout, /No saved session/);
  await assert.rejects(stat(dataDir), { code: 'ENOENT' });
});

test('one global chat: every directory opens the same database and memory', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-path-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project');
  await mkdir(project);
  const resolveFor = async (cwd: string) => resolveOptions(parseArgs(['--cwd', cwd, '--data-dir', join(folder, 'state')]));
  const main = await resolveFor(project);
  assert.equal(main.databasePath, join(folder, 'state', 'chat.sqlite'));
  assert.equal(main.memoryDir, join(folder, 'state', 'chat.unii'));
  assert.equal((await resolveFor(folder)).databasePath, main.databasePath);
  assert.equal(main.cwd, project);
});

test('flock rejects a second host and a symlink alias; status needs no credentials', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-lock-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const databasePath = join(folder, 'session.sqlite');
  const instance = await openInstance({ databasePath, cwd: folder, models: createModels(), configureAgent: false });
  await instance.close();
  const alias = join(folder, 'alias.sqlite');
  await symlink(databasePath, alias);
  const holder = spawn('flock', ['--no-fork', `${databasePath}.lock`, process.execPath, '-e',
    'process.stdout.write("ready");setInterval(()=>{},10000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(new Error(`lock holder exited ${code}`))); });
  for (const path of [databasePath, alias]) {
    await assert.rejects(exec(launcher, ['--database', path, '--status']), { code: 75, stderr: /already open/ });
  }
  const ended = new Promise(resolve => holder.once('exit', resolve));
  holder.kill('SIGKILL');
  await ended;
  const { stdout } = await exec(launcher, ['--database', alias, '--status', '--auth-file', join(folder, 'absent-auth.json')]);
  const status: unknown = JSON.parse(stdout);
  assert.ok(isRecord(status));
  assert.equal(status.pendingTasks, 0);
  assert.equal(status.scheduler, 'paused');
  assert.equal(status.database, databasePath);
  assert.equal(typeof status.modelSource, 'string');
  await assert.rejects(stat(join(folder, 'absent-auth.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(folder, 'settings.json')), { code: 'ENOENT' }, 'an inspection writes no settings');
});
