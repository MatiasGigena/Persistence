import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { DEFAULT_ROSTER } from '../../src/agents/roster.ts';
import { chromiumPath, DEFAULT_PORT, isRecord, parseArgs, parseConfig, readSettings, resolveOptions, serveSettings, SOCKET_PATH_MAX, statePaths, updateSettings,
  writeSettings } from '../../src/host/config.ts';
import { openInstance } from '../../src/runtime/runtime.ts';

const exec = promisify(execFile);
const launcher = resolve('bin/pi-durable');

test('parse prompt, tools on by default (--no-tools opts out), and namespaced model IDs', () => {
  const options = parseArgs(['--allow-tools', '--model', 'openrouter/vendor/model', '-p', 'hello']);
  assert.equal(options.allowTools, true);
  assert.deepEqual(options.model, { provider: 'openrouter', modelId: 'vendor/model' });
  assert.equal(options.prompt, 'hello');
  assert.equal(parseArgs([]).allowTools, true);
  assert.equal(parseArgs(['--no-tools']).allowTools, false);
  assert.equal(parseArgs(['--no-tools', '-p', 'x']).allowTools, false);
  assert.throws(() => parseArgs(['--allow-tools', '--no-tools']), /Choose either --allow-tools or --no-tools/);
  assert.equal(parseArgs(['backup']).allowTools, false);
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

test('the thinking level: --thinking, else settings.json, else high; updateSettings keeps the other field', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = join(folder, 'settings.json');
  const launch = async (args: string[]) => (await resolveOptions(parseArgs(['--database', join(folder, 'chat.sqlite'), '--cwd', folder, ...args]), {})).thinkingLevel;
  assert.equal(await launch([]), 'high');
  await updateSettings(settingsPath, { model: { provider: 'claude-cli', modelId: 'opus' } });
  await updateSettings(settingsPath, { thinkingLevel: 'xhigh' });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { model: 'claude-cli/opus', thinkingLevel: 'xhigh' });
  assert.equal(await launch([]), 'xhigh');
  assert.equal(await launch(['--model', 'claude-cli/sonnet']), 'xhigh', '--model alone keeps the saved level');
  assert.equal(await launch(['--thinking', 'low']), 'low');
  await updateSettings(settingsPath, { model: { provider: 'claude-cli', modelId: 'haiku' } });
  assert.deepEqual(await readSettings(settingsPath), { model: { provider: 'claude-cli', modelId: 'haiku' }, thinkingLevel: 'xhigh' });
  await writeFile(settingsPath, '{"thinkingLevel":"huge"}');
  await assert.rejects(launch([]), /settings\.json/);
  assert.equal(await launch(['--model', 'claude-cli/haiku']), 'high', 'with --model a broken file is skipped');
});

test('the standing agents: settings.json\'s "agents", else the built-in roster; an invalid entry is a launch error', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-roster-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = join(folder, 'settings.json');
  const launch = async (args: string[] = []) => (await resolveOptions(parseArgs(['--database', join(folder, 'chat.sqlite'), '--cwd', folder, ...args]), {})).roster;
  assert.deepEqual(await launch(), DEFAULT_ROSTER, 'no settings.json');
  assert.deepEqual(Object.keys(DEFAULT_ROSTER), ['Coder', 'Reviewer', 'Researcher']);
  assert.deepEqual(DEFAULT_ROSTER.Coder, { model: { provider: 'claude-cli', modelId: 'opus' }, thinkingLevel: 'medium', tools: ['coding'] });
  assert.deepEqual(DEFAULT_ROSTER.Reviewer?.tools, ['read', 'browser']);
  assert.deepEqual(DEFAULT_ROSTER.Researcher?.tools, ['web_fetch']);
  await writeFile(settingsPath, '{"model":"claude-cli/sonnet"}');
  assert.deepEqual(await launch(), DEFAULT_ROSTER, 'no "agents" key');

  const agents = {
    Coder: { model: 'claude-cli/opus', tools: ['coding', 'coding'], instructions: 'Use tabs.', subModel: 'claude-cli/sonnet', subThinkingLevel: 'low' },
    web_1: { model: 'openrouter/vendor/model', thinkingLevel: 'xhigh', tools: [] },
  };
  await writeFile(settingsPath, JSON.stringify({ thinkingLevel: 'low', agents }));
  const expected = {
    Coder: { model: { provider: 'claude-cli', modelId: 'opus' }, thinkingLevel: 'high', tools: ['coding'], instructions: 'Use tabs.',
      subModel: { provider: 'claude-cli', modelId: 'sonnet' }, subThinkingLevel: 'low' },
    web_1: { model: { provider: 'openrouter', modelId: 'vendor/model' }, thinkingLevel: 'xhigh', tools: [] },
  };
  assert.deepEqual(await launch(), expected, 'thinkingLevel defaults to high, kits deduplicated');
  assert.deepEqual((await readSettings(settingsPath)).agents, expected);
  await writeFile(settingsPath, '{"agents":{}}');
  assert.deepEqual(await launch(), {}, 'an empty roster: no standing agents');

  const bad: [unknown, RegExp][] = [
    [[], /"agents" in .*settings\.json must be an object/],
    [{ '9lives': { model: 'a/b', tools: [] } }, /"9lives".*name must be a letter/],
    [{ Pi: { model: 'a/b', tools: [] } }, /"Pi".*not "Pi"/],
    [{ Coder: { model: 'a/b', tools: [] }, coder: { model: 'a/b', tools: [] } }, /"coder".*same name/],
    [{ Coder: 'claude-cli/opus' }, /"Coder".*must be an object/],
    [{ Coder: { tools: ['coding'] } }, /"Coder".*"model" is required/],
    [{ Coder: { model: 'opus', tools: ['coding'] } }, /"Coder".*PROVIDER\/MODEL_ID/],
    [{ Coder: { model: 7, tools: ['coding'] } }, /"Coder".*"model" must be/],
    [{ Coder: { model: 'a/b' } }, /"Coder".*"tools" is required/],
    [{ Coder: { model: 'a/b', tools: 'coding' } }, /"Coder".*"tools" is required/],
    [{ Coder: { model: 'a/b', tools: ['laser'] } }, /"Coder".*coding, read, browser, web_fetch/],
    [{ Coder: { model: 'a/b', tools: [], thinkingLevel: 'huge' } }, /"Coder".*"thinkingLevel" must be one of/],
    [{ Coder: { model: 'a/b', tools: [], subThinkingLevel: 'huge' } }, /"Coder".*"subThinkingLevel"/],
    [{ Coder: { model: 'a/b', tools: [], subModel: 'sonnet' } }, /"Coder".*"subModel"/],
    [{ Coder: { model: 'a/b', tools: [], instructions: 7 } }, /"Coder".*"instructions" must be a string/],
    [{ Coder: { model: 'a/b', tools: [], thinking: 'high' } }, /"Coder".*unknown field "thinking"/],
  ];
  for (const [value, pattern] of bad) {
    await writeFile(settingsPath, JSON.stringify({ agents: value }));
    await assert.rejects(launch(), pattern, JSON.stringify(value));
    await assert.rejects(launch(['--model', 'a/b']), pattern, 'with --model too');
    await assert.rejects(launch(['--status']), pattern, 'an inspection too');
  }
  await writeFile(settingsPath, '{"thinkingLevel":"huge"}');
  assert.deepEqual(await launch(['--model', 'a/b']), DEFAULT_ROSTER, '--model skips a file broken elsewhere');
});

test('/model and /effort keep "agents" as the user wrote it', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-roster-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = join(folder, 'settings.json');
  const agents = { Coder: { model: 'claude-cli/opus', tools: ['coding'], instructions: 'Use tabs.' }, Lone: { tools: ['read'], model: 'a/b' } };
  await writeFile(settingsPath, JSON.stringify({ agents, model: 'claude-cli/haiku' }));
  await updateSettings(settingsPath, { model: { provider: 'claude-cli', modelId: 'sonnet' } });
  await updateSettings(settingsPath, { thinkingLevel: 'max' });
  const saved: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(saved, { agents, model: 'claude-cli/sonnet', thinkingLevel: 'max' });
  assert.ok(isRecord(saved));
  assert.deepEqual(Object.keys(saved), ['agents', 'model', 'thinkingLevel'], 'keys keep their places');
  writeSettings(settingsPath, { thinkingLevel: 'low' });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { thinkingLevel: 'low' }, 'a bare write is the given settings only');
  await writeFile(settingsPath, JSON.stringify({ agents: { Coder: { tools: [] } } }));
  await assert.rejects(updateSettings(settingsPath, { thinkingLevel: 'low' }), /"Coder"/, 'an invalid file is not rewritten');
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
  assert.match(stdout, /Tools are ON/);
  assert.match(stdout, /--no-tools/);
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

test('subcommands: serve, serve pair, serve devices, backup, with options before or after them', () => {
  assert.equal(parseArgs([]).command, 'chat');
  assert.equal(parseArgs(['hello']).command, 'chat');
  assert.deepEqual([parseArgs(['serve']).command, parseArgs(['serve']).allowTools], ['serve', true], 'serve starts with tools on');
  assert.equal(parseArgs(['serve', '--no-tools']).allowTools, false);
  assert.equal(parseArgs(['serve', '--allow-tools']).allowTools, true);
  assert.throws(() => parseArgs(['serve', '--allow-tools', '--no-tools']), /Choose either --allow-tools or --no-tools/);
  const serve = parseArgs(['--data-dir', '/d', 'serve', '--cwd', '/p', '--port', '8080', '--model', 'claude-cli/sonnet']);
  assert.deepEqual([serve.command, serve.dataDir, serve.cwd, serve.port, serve.model?.modelId], ['serve', '/d', '/p', 8080, 'sonnet']);
  assert.equal(parseArgs(['serve', 'pair']).command, 'serve-pair');
  assert.equal(parseArgs(['serve', 'devices']).command, 'serve-devices');
  assert.equal(parseArgs(['serve', 'devices', '--revoke', 'phone']).revoke, 'phone');
  assert.deepEqual([parseArgs(['backup']).command, parseArgs(['backup', '--out', '/b']).out], ['backup', '/b']);
  assert.deepEqual([parseArgs(['--', 'serve']).command, parseArgs(['--', 'serve']).prompt], ['chat', 'serve'], '-- makes it a prompt');
  assert.deepEqual([parseArgs(['-p', 'serve dinner']).command, parseArgs(['serve dinner']).prompt], ['chat', 'serve dinner']);
  assert.equal(parseArgs(['serve', '--help']).help, true);
});

test('each subcommand refuses what does not apply to it', () => {
  assert.throws(() => parseArgs(['serve', 'the', 'soup']), /Unknown serve argument: the \(to send a prompt starting with "serve", use -p\)/);
  for (const args of [['serve', '-p', 'x'], ['serve', '--plain'], ['serve', '--local'], ['serve', '--attach'], ['serve', '--status'],
    ['serve', '--revoke', 'x'], ['serve', '--out', '/b'], ['serve', '--request-id', 'r'], ['serve', 'pair', '--port', '1'],
    ['serve', 'pair', '--cwd', '/'], ['serve', 'devices', '--out', '/b'], ['serve', 'devices', 'phone'], ['backup', '--port', '1'],
    ['backup', '--allow-tools'], ['backup', 'now'], ['serve', '--port', '0'], ['serve', '--port', '65536'], ['serve', '--port', 'http'],
    ['serve', 'devices', '--revoke', ' ']]) {
    assert.throws(() => parseArgs(args), Error, JSON.stringify(args));
  }
  assert.throws(() => parseArgs(['--port', '7433']), /--port applies only to serve/);
  assert.throws(() => parseArgs(['--revoke', 'x']), /--revoke applies only to serve devices/);
  assert.throws(() => parseArgs(['--out', '/b']), /--out applies only to backup/);
});

test('--local and --attach: one or the other, and --attach takes no launch settings or one-shot mode', () => {
  assert.equal(parseArgs(['--local']).local, true);
  assert.equal(parseArgs(['--local', '--allow-tools', '-p', 'x']).allowTools, true);
  assert.equal(parseArgs(['--attach']).attach, true);
  assert.throws(() => parseArgs(['--local', '--attach']), /Choose either --local or --attach/);
  for (const flag of [['--allow-tools'], ['--no-tools'], ['--model', 'a/b'], ['--thinking', 'low'], ['--cwd', '/'], ['--auth-file', '/a'], ['--plain']]) {
    assert.throws(() => parseArgs(['--attach', ...flag]), new RegExp(`${flag[0] ?? ''} does not apply to --attach`));
  }
  for (const mode of [['-p', 'x'], ['hello'], ['--status'], ['--history'], ['--resume']]) {
    assert.throws(() => parseArgs(['--attach', ...mode]), /--attach is for interactive chat only/, mode.join(' '));
  }
});

test('PI_DURABLE_CHROMIUM: unset for Playwright\'s own, else an absolute path carried to the host', async t => {
  assert.equal(chromiumPath({}), undefined);
  assert.equal(chromiumPath({ PI_DURABLE_CHROMIUM: '' }), undefined);
  assert.equal(chromiumPath({ PI_DURABLE_CHROMIUM: '/opt/chrome/chrome' }), '/opt/chrome/chrome');
  assert.throws(() => chromiumPath({ PI_DURABLE_CHROMIUM: 'chrome' }), /PI_DURABLE_CHROMIUM must be an absolute path/);
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-chromium-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const args = parseArgs(['--database', join(folder, 'chat.sqlite'), '--cwd', folder]);
  const config = await resolveOptions(args, { PI_DURABLE_CHROMIUM: '/opt/chrome/chrome' });
  assert.equal(parseConfig(JSON.stringify(config)).chromium, '/opt/chrome/chrome');
  assert.equal((await resolveOptions(args, {})).chromium, undefined);
  await assert.rejects(resolveOptions(args, { PI_DURABLE_CHROMIUM: './chrome' }), /PI_DURABLE_CHROMIUM/);
});

test('serve settings from --port and the environment, each variable checked', () => {
  assert.deepEqual(serveSettings({}, {}), { port: DEFAULT_PORT, allowLogins: [], remoteTools: 'confirm', pushPreview: false }, 'no idle turn-off');
  assert.equal(serveSettings({}, { PI_DURABLE_TOOLS_IDLE_MIN: 'off' }).toolsIdleMinutes, undefined);
  const env = { PI_DURABLE_ORIGIN: 'https://vps.tail1234.ts.net/', PI_DURABLE_ALLOW_LOGIN: ' me@github , you@example.com,',
    PI_DURABLE_PORT: '8443', PI_DURABLE_REMOTE_TOOLS: 'off', PI_DURABLE_TOOLS_IDLE_MIN: '5', PI_DURABLE_PUSH_PREVIEW: 'on' };
  assert.deepEqual(serveSettings({}, env), { port: 8443, origin: 'https://vps.tail1234.ts.net', allowLogins: ['me@github', 'you@example.com'],
    remoteTools: 'off', toolsIdleMinutes: 5, pushPreview: true });
  assert.equal(serveSettings({ port: 9000 }, env).port, 9000, '--port beats PI_DURABLE_PORT');
  assert.equal(serveSettings({}, { PI_DURABLE_ORIGIN: 'http://127.0.0.1:7433' }).origin, 'http://127.0.0.1:7433', 'http on loopback, for development');
  for (const [name, value] of [['PI_DURABLE_ORIGIN', 'http://vps.example'], ['PI_DURABLE_ORIGIN', 'https://vps.example/app'],
    ['PI_DURABLE_ORIGIN', 'vps.example'], ['PI_DURABLE_ORIGIN', 'https://user@vps.example'], ['PI_DURABLE_ALLOW_LOGIN', 'me@github, two words'],
    ['PI_DURABLE_PORT', '0'], ['PI_DURABLE_PORT', 'x'], ['PI_DURABLE_REMOTE_TOOLS', 'on'], ['PI_DURABLE_TOOLS_IDLE_MIN', '0'],
    ['PI_DURABLE_TOOLS_IDLE_MIN', '1441'], ['PI_DURABLE_TOOLS_IDLE_MIN', '2.5'], ['PI_DURABLE_PUSH_PREVIEW', 'yes']] as const) {
    assert.throws(() => serveSettings({}, { [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test('state paths: the socket beside the chat, or in XDG_RUNTIME_DIR when that path is too long', () => {
  const paths = statePaths('/s/chat.sqlite', {});
  assert.deepEqual(paths, { lock: '/s/chat.sqlite.lock', memoryDir: '/s/chat.unii', settings: '/s/settings.json', socket: '/s/chat.sqlite.sock',
    serveDir: '/s/serve', vapid: '/s/serve/vapid.json', push: '/s/serve/push.json', devices: '/s/serve/devices.json' });
  const deep = `/${'d'.repeat(SOCKET_PATH_MAX)}/chat.sqlite`;
  const fallback = statePaths(deep, { XDG_RUNTIME_DIR: '/run/user/1000' }).socket ?? '';
  assert.match(fallback, /^\/run\/user\/1000\/pi-durable-[0-9a-f]{16}\.sock$/);
  assert.equal(statePaths(deep, { XDG_RUNTIME_DIR: '/run/user/1000' }).socket, fallback, 'stable for one database');
  assert.notEqual(statePaths(`${deep}2`, { XDG_RUNTIME_DIR: '/run/user/1000' }).socket, fallback);
  assert.equal(statePaths(deep, {}).socket, undefined, 'never /tmp, where another user could squat it');
  const edge = `/${'e'.repeat(SOCKET_PATH_MAX - '/.sock'.length)}`;
  assert.equal(statePaths(edge, {}).socket, `${edge}.sock`, 'exactly 107 bytes still fits');
});

test('resolved serve and admin configs survive the trip to the host; admin commands create nothing', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-serve-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const config = await resolveOptions(parseArgs(['serve', '--data-dir', join(folder, 'state'), '--cwd', folder, '--port', '8000']),
    { PI_DURABLE_ORIGIN: 'https://vps.ts.net', PI_DURABLE_ALLOW_LOGIN: 'me@github' });
  assert.equal(config.command, 'serve');
  assert.deepEqual(config.serve, { port: 8000, origin: 'https://vps.ts.net', allowLogins: ['me@github'], remoteTools: 'confirm', pushPreview: false });
  assert.equal(config.socketPath, join(folder, 'state', 'chat.sqlite.sock'));
  assert.equal(config.serveDir, join(folder, 'state', 'serve'));
  assert.deepEqual(parseConfig(JSON.stringify(config)), JSON.parse(JSON.stringify(config)));
  assert.throws(() => parseConfig(JSON.stringify({ ...config, command: 'daemon' })), /invalid host configuration/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, serve: { ...config.serve, remoteTools: 'on' } })), /invalid host configuration/);
  assert.deepEqual(config.roster, DEFAULT_ROSTER);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, roster: undefined })), /invalid host configuration/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, roster: { Coder: { ...DEFAULT_ROSTER.Coder, tools: ['laser'] } } })), /invalid host configuration/);
  const chat = await resolveOptions(parseArgs(['--data-dir', join(folder, 'state'), '--cwd', folder]), { PI_DURABLE_PORT: 'junk' });
  assert.equal(chat.serve, undefined, 'only serve reads the server environment');
  for (const args of [['serve', 'pair'], ['serve', 'devices'], ['backup']]) {
    const dataDir = join(folder, 'absent');
    assert.equal((await resolveOptions(parseArgs([...args, '--data-dir', dataDir]), {})).exists, false);
    await assert.rejects(stat(dataDir), { code: 'ENOENT' }, args.join(' '));
  }
});

test('the admin commands need a running server or a saved chat', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-admin-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = { ...process.env, PI_DURABLE_DATA_DIR: join(folder, 'state') };
  for (const args of [['serve', 'pair'], ['serve', 'devices'], ['serve', 'devices', '--revoke', 'phone']]) {
    await assert.rejects(exec(launcher, args, { env }), { code: 1, stderr: /No server is running for this chat/ }, args.join(' '));
  }
  await assert.rejects(exec(launcher, ['backup'], { env }), { code: 1, stderr: /No saved chat to back up/ });
});
