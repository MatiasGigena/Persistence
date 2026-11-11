import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ModelRef } from '@earendil-works/pi-durable';
import { saveClientConfig } from '../../src/client/config.ts';
import { SSH_OPTIONS } from '../../src/client/ssh-link.ts';
import { HELP, parseArgs } from '../../src/config/options.ts';
import { doctor, doctorText, onPath, runDoctor, withTimeout } from '../../src/host/doctor.ts';
import type { Check, DoctorDeps } from '../../src/host/doctor.ts';
import type { Protection } from '../../src/runtime/guard.ts';
import { FakeServer } from '../fixtures/fake-server.ts';
import { offlineModels } from '../fixtures/faux-model.ts';
import { listenFake } from '../client/socket-server.ts';

const IDS = ['node', 'flock', 'sandbox', 'ssh-keys', 'settings', 'model', 'agents', 'autoreview', 'chat', 'memory', 'backups', 'remote', 'server'];
const NOW = Date.parse('2026-11-10T12:00:00Z');
const machineId = 'ab0c2d3e-0000-4000-8000-123456789abc';

/** A machine in a temporary folder: its home, PATH (`bin`) and data dir, with every probe faked and passing. */
interface Machine {
  readonly folder: string;
  readonly home: string;
  readonly bin: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model: ModelRef;
  /** `pi-durable doctor --data-dir <dataDir> ...args`, with `more` over the fakes. */
  run(args?: readonly string[], more?: DoctorDeps): Promise<Check[]>;
  /** Writes `content` (default: an executable that exits 0) at `path`, with its folders. */
  file(path: string, content?: string, mode?: number): Promise<void>;
}

async function machine(t: { after(callback: () => Promise<void>): void }): Promise<Machine> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-doctor-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const home = join(folder, 'home'), bin = join(folder, 'bin'), dataDir = join(folder, 'data');
  await Promise.all([home, bin].map(dir => mkdir(dir)));
  // Nothing of the developer's environment: no saved remote, no PI_DURABLE_* setting.
  const env: NodeJS.ProcessEnv = { PATH: bin, PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json') };
  const { models, model } = offlineModels();
  const deps: DoctorDeps = { env, home, node: '22.19.0', now: NOW, models, sandbox: () => Promise.resolve(undefined),
    access: () => Promise.resolve({ ok: true }), playwrightChromium: () => join(folder, 'chrome'), serverAnswers: () => Promise.resolve(false),
    ssh: () => Promise.reject(new Error('no ssh in this test')) };
  const file = async (path: string, content = '#!/bin/sh\nexit 0\n', mode = 0o755): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode });
  };
  await file(join(bin, 'flock'));
  return { folder, home, bin, dataDir, env, model, file,
    run: (args = [], more = {}) => runDoctor(parseArgs(['doctor', '--data-dir', dataDir, '--model', `${model.provider}/${model.modelId}`, ...args]), { ...deps, ...more }) };
}

/** settings.json with the faux model for the launch and for two standing agents. */
const settingsOf = ({ provider, modelId }: ModelRef): string => JSON.stringify({ model: `${provider}/${modelId}`, thinkingLevel: 'low',
  agents: { Coder: { model: `${provider}/${modelId}`, tools: ['coding'] }, Reviewer: { model: `${provider}/${modelId}`, tools: ['read', 'browser', 'autoreview'] } } });

/** The one line of check `id`. */
function one(checks: readonly Check[], id: string): Check {
  const found = checks.filter(check => check.id === id);
  assert.equal(found.length, 1, `${id}: ${JSON.stringify(found)}`);
  return found[0] ?? assert.fail();
}
const shown = (check: Check): string => `${check.level} ${check.subject}: ${check.detail}`;

/** Every entry under `root` with its content hash and modification time; [] when `root` is absent. */
async function snapshot(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true }).catch(() => []);
  return Promise.all(names.sort().map(async name => {
    const info = await lstat(join(root, name));
    return `${name} ${info.isFile() ? createHash('sha256').update(await readFile(join(root, name))).digest('hex') : 'dir'} ${info.mtimeMs}`;
  }));
}

test('parseArgs: doctor and its flags; other commands refuse them, and a prompt starting with "doctor" needs -p', () => {
  const options = parseArgs(['doctor', '--json', '--remote-check', '--local', '--data-dir', '/state', '--model', 'claude-cli/opus', '--auth-file', '/auth.json']);
  assert.equal(options.command, 'doctor');
  assert.deepEqual([options.json, options.remoteCheck, options.local, options.dataDir, options.authFile], [true, true, true, '/state', '/auth.json']);
  assert.deepEqual(options.model, { provider: 'claude-cli', modelId: 'opus' });
  assert.equal(options.allowTools, false, 'doctor turns nothing on');
  assert.equal(parseArgs(['doctor', '--database', '/state/chat.sqlite']).json, undefined);
  for (const flag of ['--json', '--remote-check']) {
    assert.throws(() => parseArgs([flag]), { message: `${flag} applies only to doctor` });
    assert.throws(() => parseArgs(['-p', 'hello', flag]), { message: `${flag} applies only to doctor` });
    for (const command of ['serve', 'backup', 'bridge']) assert.throws(() => parseArgs([command, flag]), { message: `${flag} does not apply to ${command}` });
    assert.throws(() => parseArgs(['serve', 'pair', flag]), { message: `${flag} does not apply to serve pair` });
    assert.throws(() => parseArgs(['connect', 'host', flag]), { message: `${flag} does not apply to connect` });
    assert.throws(() => parseArgs(['doctor', `${flag}=yes`]), { message: `${flag} takes no value` });
  }
  for (const args of [['--cwd', '/x'], ['--no-tools'], ['--thinking', 'low'], ['--port', '1'], ['--remote', 'host']]) {
    assert.throws(() => parseArgs(['doctor', ...args]), { message: `${args[0] ?? ''} does not apply to doctor` });
  }
  assert.throws(() => parseArgs(['doctor', 'my', 'code']), { message: 'Unknown doctor argument: my (to send a prompt starting with "doctor", use -p)' });
  assert.equal(parseArgs(['-p', 'doctor my code']).prompt, 'doctor my code');
  assert.equal(parseArgs(['--', 'doctor', 'my', 'code']).prompt, 'doctor my code');
  assert.equal(parseArgs(['what', 'would', 'a', 'doctor', 'say']).prompt, 'what would a doctor say');
  assert.match(HELP, /pi-durable doctor \[--json\] \[--remote-check\] \[--local\]/);
  assert.match(HELP, /first word is serve, backup, connect, bridge or doctor needs -p/);
});

test('a server with everything in place: every check in its fixed order, none failing', async t => {
  const m = await machine(t), db = join(m.dataDir, 'chat.sqlite'), skill = join(m.home, '.pi', 'agent', 'skills', 'autoreview');
  for (const tool of ['tailscale', 'ssh-agent', 'ssh-add', 'python3']) await m.file(join(m.bin, tool));
  await m.file(join(m.folder, 'chrome'));
  await m.file(join(m.home, '.ssh', 'id_push'), 'key', 0o600);
  await m.file(db, 'x'.repeat(2048), 0o600);
  await m.file(join(m.dataDir, 'settings.json'), settingsOf(m.model), 0o600);
  for (const day of ['2026-11-09', '2026-11-10']) await m.file(join(m.dataDir, 'chat.unii', 'main', `${day}.jsonl`), '{}\n', 0o600);
  await m.file(join(m.dataDir, 'chat.unii', 'view.json'), '{"lines":[]}', 0o600);
  await mkdir(join(m.dataDir, 'backups', '2026-11-09T03-00-00Z'), { recursive: true });
  await mkdir(join(m.dataDir, 'backups', '2026-10-30T03-00-00Z'));
  await m.file(join(skill, 'SKILL.md'), '# autoreview', 0o600);
  await m.file(join(skill, 'scripts', 'autoreview'), 'print()', 0o600);
  await m.file(join(m.home, '.local', 'share', 'autoreview', 'codex-cli', 'bin', 'codex'));
  await m.file(join(m.home, '.config', 'systemd', 'user', 'pi-durable.service'), '[Service]\n', 0o600);
  Object.assign(m.env, { PI_DURABLE_SSH_KEYS: '~/.ssh/id_push', PI_DURABLE_ORIGIN: 'https://vps.tailnet.ts.net', PI_DURABLE_ALLOW_LOGIN: 'me@github, you@github' });
  const guarded: Protection[] = [];
  const checks = await m.run([], { sandbox: protection => { guarded.push(protection); return Promise.resolve(undefined); },
    serverAnswers: socket => Promise.resolve(socket === `${db}.sock`) });
  assert.deepEqual(checks.map(check => check.id), IDS);
  assert.deepEqual(checks.map(shown), [
    'ok Node.js: 22.19.0 (needs 22.19 or newer)',
    'ok flock: on PATH (a local chat and serve lock the chat with it)',
    'ok bubblewrap: bash runs in its sandbox',
    'ok SSH keys: 1 key readable; ssh-agent and ssh-add found',
    `ok settings.json: ${join(m.dataDir, 'settings.json')}: model faux/faux-1, effort low, its own standing agents`,
    'ok model faux/faux-1 (--model): credentials found',
    'ok standing agents: Coder (faux/faux-1), Reviewer (faux/faux-1) can run',
    `ok autoreview: the skill at ${skill}, python3 and the Codex CLI found`,
    `ok chat: ${db}, 2.0 KiB; a server runs this chat (${db}.sock)`,
    `ok memory: 2 day files in ${join(m.dataDir, 'chat.unii', 'main')}; view.json parses`,
    `ok backups: newest 2026-11-09T03-00-00Z, 33 h old, in ${join(m.dataDir, 'backups')}`,
    'skip remote: no remote server is saved (pi-durable connect SSH_HOST saves one)',
    'ok server: web app at https://vps.tailnet.ts.net for me@github, you@github (the environment); tailscale found',
  ]);
  assert.ok(checks.every(check => check.fix === undefined));
  // The sandbox is probed with the launch's own protection: the chat's state and the credentials hidden.
  assert.ok(guarded[0]?.hidden.includes(m.dataDir) && guarded[0].hidden.includes(join(m.home, '.ssh')));
});

test('a new machine: nothing saved is fine, and what does not apply is skipped', async t => {
  const m = await machine(t);
  const checks = await m.run();
  assert.equal(shown(one(checks, 'ssh-keys')), 'skip SSH keys: PI_DURABLE_SSH_KEYS is not set');
  assert.equal(shown(one(checks, 'settings')), `ok settings.json: none at ${join(m.dataDir, 'settings.json')}; the defaults apply`);
  assert.equal(shown(one(checks, 'chat')), `ok chat: no saved chat yet (${join(m.dataDir, 'chat.sqlite')})`);
  assert.equal(shown(one(checks, 'memory')), `skip memory: no memory yet (${join(m.dataDir, 'chat.unii')})`);
  assert.equal(shown(one(checks, 'backups')), 'skip backups: no saved chat to back up');
  assert.equal(shown(one(checks, 'server')), 'skip server: no systemd user unit and no web settings here');
  await assert.rejects(lstat(m.dataDir), { code: 'ENOENT' });
});

test('node, flock and bubblewrap: an old Node, a missing flock and a sandbox that cannot run FAIL with their fix', async t => {
  const m = await machine(t);
  await rm(join(m.bin, 'flock'));
  const missing = 'bwrap is not installed. Install bubblewrap (sudo apt install bubblewrap).';
  const checks = await m.run([], { node: '22.18.3', sandbox: () => Promise.resolve(missing) });
  assert.deepEqual(one(checks, 'node'), { id: 'node', level: 'FAIL', subject: 'Node.js', detail: '22.18.3 (needs 22.19 or newer)',
    fix: 'Install a newer Node, or set PI_DURABLE_NODE to one' });
  assert.deepEqual(one(checks, 'flock'), { id: 'flock', level: 'FAIL', subject: 'flock', detail: 'not on PATH; a local chat and serve cannot start',
    fix: 'Install util-linux (sudo apt install util-linux)' });
  assert.deepEqual(one(checks, 'sandbox'), { id: 'sandbox', level: 'FAIL', subject: 'bubblewrap', detail: `bash is off. ${missing}`,
    fix: 'sudo apt install bubblewrap (without root: the ~/.local/bin recipe in docs/operations.md, Requirements)' });
  const denied = one(await m.run([], { node: '24.1.0', sandbox: () => Promise.resolve('bubblewrap cannot run here: setting up uid map: Permission denied') }), 'sandbox');
  assert.equal(denied.fix, 'Allow unprivileged user namespaces for bwrap (docs/operations.md, Troubleshooting)');
  assert.equal(one(await m.run([], { node: '24.1.0' }), 'node').level, 'ok');
  assert.equal(one(await m.run([], { node: '22.20.0' }), 'node').level, 'ok');
  assert.equal(one(await m.run([], { node: '21.99.0' }), 'node').level, 'FAIL');
});

test('onPath finds executable files only; withTimeout answers late work', async t => {
  const m = await machine(t);
  await m.file(join(m.bin, 'plain'), 'text', 0o644);
  await mkdir(join(m.bin, 'folder'));
  assert.deepEqual(await Promise.all(['flock', 'plain', 'folder', 'absent'].map(name => onPath(name, m.env))), [true, false, false, false]);
  assert.equal(await onPath('flock', {}), false);
  assert.equal(await withTimeout(Promise.resolve('done'), 1000, () => 'late'), 'done');
  assert.equal(await withTimeout(new Promise<string>(() => {}), 10, () => 'late'), 'late');
});

test('ssh-keys: an unreadable key or a missing OpenSSH tool warns', async t => {
  const m = await machine(t), key = join(m.home, '.ssh', 'id_push');
  m.env.PI_DURABLE_SSH_KEYS = `~/.ssh/id_push:${join(m.folder, 'gone')}`;
  await m.file(key, 'key', 0o600);
  for (const tool of ['ssh-agent', 'ssh-add']) await m.file(join(m.bin, tool));
  assert.deepEqual(one(await m.run(), 'ssh-keys'), { id: 'ssh-keys', level: 'warn', subject: 'SSH keys',
    detail: `${join(m.folder, 'gone')} cannot be read. Pi's SSH agent will lack those keys.`,
    fix: 'Fix the paths in PI_DURABLE_SSH_KEYS (docs/operations.md, Protected folders)' });
  m.env.PI_DURABLE_SSH_KEYS = key;
  await rm(join(m.bin, 'ssh-add'));
  assert.deepEqual(one(await m.run(), 'ssh-keys'), { id: 'ssh-keys', level: 'warn', subject: 'SSH keys',
    detail: 'ssh-add is not on PATH. Pi\'s SSH agent will lack its keys.', fix: 'Install the OpenSSH client (sudo apt install openssh-client)' });
});

test('settings: a file that is not JSON fails once, and the checks that read it are skipped', async t => {
  const m = await machine(t), path = join(m.dataDir, 'settings.json');
  await m.file(path, '{', 0o600);
  // Without --model the launch reads the saved model, so it cannot be resolved either.
  const run = (): Promise<Check[]> => runDoctor(parseArgs(['doctor', '--data-dir', m.dataDir]), { env: m.env, home: m.home,
    models: offlineModels().models, access: () => Promise.resolve({ ok: true }), sandbox: () => Promise.resolve(undefined) });
  const broken = await run(), settings = one(broken, 'settings');
  assert.equal(settings.level, 'FAIL');
  assert.match(settings.detail, new RegExp(`^${path} is not valid JSON \\(.*\\); fix or delete it$`));
  assert.equal(settings.fix, 'Fix the file; it may hold a custom "agents" roster, so delete it only if it has none (docs/operations.md, Troubleshooting)');
  for (const id of ['model', 'agents', 'autoreview']) assert.equal(one(broken, id).detail, 'settings.json must be fixed first', id);
  assert.equal(broken.filter(check => check.level === 'FAIL').length, 1);

  // An invalid roster stops the agents' checks only: the model is still the saved one.
  await writeFile(path, JSON.stringify({ model: 'faux/faux-1', agents: { Pi: { model: 'faux/faux-1', tools: [] } } }));
  const roster = await run();
  assert.match(one(roster, 'settings').detail, /^Standing agent "Pi" in .*: the name must be a letter/);
  assert.equal(shown(one(roster, 'model')), 'ok model faux/faux-1 (saved by /model): credentials found');
  assert.equal(one(roster, 'agents').level, 'skip');

  await writeFile(path, '{"thinkingLevel":"high"}');
  assert.equal(one(await m.run(), 'settings').detail, `${path}: effort high, the built-in standing agents`);
});

test('model: where it came from, a model outside the catalog, missing credentials, a check that timed out', async t => {
  const m = await machine(t);
  const plain = (env: NodeJS.ProcessEnv, more: DoctorDeps = {}): Promise<Check[]> => runDoctor(parseArgs(['doctor', '--data-dir', m.dataDir]),
    { env: { ...m.env, ...env }, home: m.home, models: offlineModels().models, access: () => Promise.resolve({ ok: true }), sandbox: () => Promise.resolve(undefined), ...more });
  assert.equal(one(await plain({ PI_DURABLE_MODEL: 'faux/faux-1' }), 'model').subject, 'model faux/faux-1 (PI_DURABLE_MODEL)');
  const unknown = one(await plain({}), 'model');
  assert.deepEqual([unknown.level, unknown.subject], ['FAIL', 'model openai-codex/gpt-6.1-sol (the default)']);
  assert.match(unknown.detail, /^Unknown model openai-codex\/gpt-6\.1-sol in pinned Pi [\d.]+ catalog$/);
  assert.match(unknown.fix ?? '', /^Pick a model from the Pi [\d.]+ catalog; check PI_DURABLE_MODEL and settings\.json/);
  const malformed = one(await plain({ PI_DURABLE_MODEL: 'nonsense' }), 'model');
  assert.deepEqual([malformed.level, malformed.detail, malformed.fix], ['FAIL', 'PI_DURABLE_MODEL must be PROVIDER/MODEL_ID', 'Set PI_DURABLE_MODEL to PROVIDER/MODEL_ID, or unset it']);

  const none = one(await m.run([], { access: () => Promise.resolve({ ok: false, reason: 'none' }) }), 'model');
  assert.equal(none.level, 'FAIL');
  assert.match(none.detail, new RegExp(`^No credentials for faux\\..* Auth file: ${join(m.home, '.pi', 'agent', 'auth.json')}$`));
  assert.match(none.fix ?? '', /^npm exec -- pi in .*, then \/login; or set the provider's API-key variable, or pass --auth-file$/);
  const custom = one(await m.run(['--auth-file', join(m.folder, 'other.json')], { access: () => Promise.resolve({ ok: false, reason: 'none' }) }), 'model');
  assert.match(custom.detail, new RegExp(`Auth file: ${join(m.folder, 'other.json')}$`));
  const late = one(await m.run([], { access: () => Promise.resolve({ ok: false, reason: 'timeout' }) }), 'model');
  assert.deepEqual([late.level, late.detail], ['warn', 'Checking the credentials for faux timed out.']);
});

test('model: the host\'s own runtime finds a fake claude CLI\'s login, and never creates Pi\'s auth file', async t => {
  const m = await machine(t), claude = join(m.folder, 'claude');
  await m.file(claude, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n');
  m.env.PI_DURABLE_CLAUDE_BIN = claude;
  const real = (args: readonly string[]): Promise<Check[]> => runDoctor(parseArgs(['doctor', '--data-dir', m.dataDir, ...args]),
    { env: m.env, home: m.home, sandbox: () => Promise.resolve(undefined), playwrightChromium: () => join(m.folder, 'chrome') });
  const signedIn = await real(['--model', 'claude-cli/sonnet']);
  assert.equal(shown(one(signedIn, 'model')), 'ok model claude-cli/sonnet (--model): credentials found');
  // The built-in roster: Coder runs on the same login; the others need Pi's, and the Reviewer a Chromium.
  const agents = signedIn.filter(check => check.id === 'agents');
  assert.deepEqual(agents.map(check => check.level), ['warn', 'warn']);
  assert.match(agents[0]?.detail ?? '', /^Standing agent Reviewer cannot browse: Playwright's Chromium is not installed/);
  assert.match(agents[0]?.fix ?? '', /^npx --no-install playwright-core install chromium in .*, or set PI_DURABLE_CHROMIUM$/);
  assert.match(agents[1]?.detail ?? '', /^Standing agents Reviewer, Researcher cannot run: No credentials for openai-codex/);
  assert.equal(agents[1]?.fix, 'Sign in to that provider, or set another model for the agent in settings.json\'s "agents" (docs/operations.md, Troubleshooting)');

  await writeFile(claude, '#!/bin/sh\necho \'{"loggedIn":false}\'\n');
  const signedOut = one(await real(['--model', 'claude-cli/sonnet']), 'model');
  assert.deepEqual([signedOut.level, signedOut.fix], ['FAIL', 'claude auth login']);
  assert.match(signedOut.detail, /^No Claude Code login for claude-cli/);
  assert.equal(one(await real(['--model', 'claude-cli/gpt']), 'model').detail, 'Unknown model claude-cli/gpt. Use opus, sonnet, haiku or fable.');
  await assert.rejects(lstat(join(m.home, '.pi')), { code: 'ENOENT' });
});

test('agents: the roster\'s warnings become warn lines; none is one ok line; a bad PI_DURABLE_CHROMIUM fails', async t => {
  const m = await machine(t), path = join(m.dataDir, 'settings.json');
  // The built-in roster against a catalog that lacks its models.
  const builtin = (await m.run()).filter(check => check.id === 'agents');
  assert.ok(builtin.length > 1 && builtin.every(check => check.level === 'warn' && check.subject === 'standing agents' && check.fix));
  assert.match(builtin.map(check => check.detail).join('\n'), /Standing agent Coder: Unknown model claude-cli\/opus/);
  await m.file(path, settingsOf(m.model), 0o600);
  const checked: string[] = [];
  const browser = (await m.run([], { access: provider => { checked.push(provider); return Promise.resolve({ ok: true }); } })).filter(check => check.id === 'agents');
  assert.deepEqual(browser.map(check => check.detail), [`Standing agent Reviewer cannot browse: Playwright's Chromium is not installed (${join(m.folder, 'chrome')}). `
    + 'Run npx --no-install playwright-core install chromium in the installation directory, or set PI_DURABLE_CHROMIUM to a Chromium executable (docs/operations.md).']);
  assert.deepEqual(checked, ['faux'], 'one credential check serves the launch model and the agents');
  await m.file(join(m.folder, 'chromium'));
  m.env.PI_DURABLE_CHROMIUM = join(m.folder, 'chromium');
  assert.equal(shown(one(await m.run(), 'agents')), 'ok standing agents: Coder (faux/faux-1), Reviewer (faux/faux-1) can run');
  m.env.PI_DURABLE_CHROMIUM = 'chromium';
  assert.deepEqual(one(await m.run(), 'agents'), { id: 'agents', level: 'FAIL', subject: 'standing agents',
    detail: 'PI_DURABLE_CHROMIUM must be an absolute path to the Chromium executable', fix: 'Set PI_DURABLE_CHROMIUM to an absolute path, or unset it for Playwright\'s Chromium' });
  await writeFile(path, '{"agents":{}}');
  assert.equal(shown(one(await m.run(), 'agents')), 'ok standing agents: settings.json has none');
  assert.equal(shown(one(await m.run(), 'autoreview')), 'skip autoreview: no standing agent has the autoreview kit');
});

test('autoreview: the skill, python3 and the Codex CLI where the tool runs them, under PI_CODING_AGENT_DIR when set', async t => {
  const m = await machine(t), agentDir = join(m.folder, 'pi-agent'), skill = join(agentDir, 'skills', 'autoreview');
  const codex = join(m.home, '.local', 'share', 'autoreview', 'codex-cli', 'bin', 'codex');
  const missing = one(await m.run(), 'autoreview'), home = join(m.home, '.pi', 'agent', 'skills', 'autoreview');
  assert.deepEqual(missing, { id: 'autoreview', level: 'warn', subject: 'autoreview',
    detail: `Reviewer cannot review code here: ${join(home, 'SKILL.md')} is missing; ${join(home, 'scripts', 'autoreview')} is missing; `
      + `python3 is not on PATH; the standalone Codex CLI is not at ${codex}`,
    fix: 'Install the skill and the Codex CLI on each machine where reviews run (docs/operations.md, Autoreview)' });
  m.env.PI_CODING_AGENT_DIR = agentDir;
  await m.file(join(skill, 'SKILL.md'), '# autoreview', 0o600);
  await m.file(join(skill, 'scripts', 'autoreview'), 'print()', 0o600);
  await m.file(join(m.bin, 'python3'));
  // A codex on PATH is not the one the tool runs.
  await m.file(join(m.bin, 'codex'));
  assert.equal(one(await m.run(), 'autoreview').detail, `Reviewer cannot review code here: the standalone Codex CLI is not at ${codex}`);
  await m.file(codex);
  assert.equal(shown(one(await m.run(), 'autoreview')), `ok autoreview: the skill at ${skill}, python3 and the Codex CLI found`);
});

test('chat: a real server on the socket is named; a folder in the database\'s place fails', async t => {
  const m = await machine(t), db = join(m.dataDir, 'chat.sqlite');
  await m.file(db, 'x'.repeat(300), 0o600);
  const noServer = { ...await machine(t), serverAnswers: undefined };
  assert.equal(noServer.serverAnswers, undefined);
  const real = (): Promise<Check[]> => runDoctor(parseArgs(['doctor', '--database', db, '--model', 'faux/faux-1']),
    { env: m.env, home: m.home, models: offlineModels().models, access: () => Promise.resolve({ ok: true }), sandbox: () => Promise.resolve(undefined) });
  assert.equal(shown(one(await real(), 'chat')), `ok chat: ${db}, 300 bytes; no server answers on its socket`);
  const listening = await listenFake(new FakeServer(), `${db}.sock`);
  try {
    assert.equal(shown(one(await real(), 'chat')), `ok chat: ${db}, 300 bytes; a server runs this chat (${db}.sock)`);
  } finally { await listening.close(); }
  await rm(db);
  await mkdir(db);
  assert.deepEqual(one(await real(), 'chat'), { id: 'chat', level: 'FAIL', subject: 'chat', detail: `${db} is not a file, so no chat can open there`,
    fix: 'Move it away, or name the database with --database' });
});

test('memory: the day files are counted; an unreadable view warns, a missing log fails', async t => {
  const m = await machine(t), dir = join(m.dataDir, 'chat.unii');
  await m.file(join(dir, 'main', '2026-11-10.jsonl'), '{}\n', 0o600);
  await m.file(join(dir, 'main', 'notes.txt'), '', 0o600);
  assert.equal(shown(one(await m.run(), 'memory')), `ok memory: 1 day file in ${join(dir, 'main')}; no view.json yet`);
  await m.file(join(dir, 'view.json'), '{"lines":', 0o600);
  const view = one(await m.run(), 'memory');
  assert.equal(view.level, 'warn');
  assert.match(view.detail, /^1 day file in .*; view\.json cannot be read \(.*\), so the next launch folds the log again$/);
  assert.equal(view.fix, 'Nothing to do if the next launch opens; if its view is wrong, restore chat.unii/ from a backup (docs/operations.md, Backups)');
  await rm(join(dir, 'main'), { recursive: true });
  const log = one(await m.run(), 'memory');
  assert.equal(log.level, 'FAIL');
  assert.match(log.detail, new RegExp(`^the log ${join(dir, 'main')} cannot be read \\(ENOENT`));
  assert.equal(log.fix, 'Restore chat.unii/ from a backup (docs/operations.md, Backups)');
});

test('backups: a chat with none, or with only an old one, warns', async t => {
  const m = await machine(t), root = join(m.dataDir, 'backups');
  const fix = 'pi-durable backup; for a daily one, the timer in contrib/systemd/ (docs/operations.md, Backups)';
  await m.file(join(m.dataDir, 'chat.sqlite'), 'x', 0o600);
  assert.deepEqual(one(await m.run(), 'backups'), { id: 'backups', level: 'warn', subject: 'backups', detail: `no backup in ${root}`, fix });
  // Only stamped names are backups.
  await mkdir(join(root, 'notes'), { recursive: true });
  assert.equal(one(await m.run(), 'backups').detail, `no backup in ${root}`);
  await mkdir(join(root, '2026-11-01T03-00-00Z'));
  assert.deepEqual(one(await m.run(), 'backups'), { id: 'backups', level: 'warn', subject: 'backups', detail: `newest 2026-11-01T03-00-00Z, 9 days old, in ${root}`, fix });
  await mkdir(join(root, '2026-11-03T03-00-00Z-2'));
  assert.equal(shown(one(await m.run(), 'backups')), `ok backups: newest 2026-11-03T03-00-00Z-2, 7 days old, in ${root}`);
  await mkdir(join(root, '2026-11-10T11-40-00Z'));
  assert.equal(one(await m.run(), 'backups').detail, `newest 2026-11-10T11-40-00Z, 20 min old, in ${root}`);
});

test('remote: a workstation\'s saved server is named, its chat\'s checks skipped, and --remote-check tries the login as the link does', async t => {
  const m = await machine(t), config = join(m.folder, 'client.json');
  await m.file(join(m.dataDir, 'chat.sqlite'), 'x', 0o600);
  await saveClientConfig({ machineId, ssh: { host: 'me@central', command: '/opt/pi/bin/pi-durable' } }, m.env);
  const noSsh = one(await m.run(), 'remote');
  assert.deepEqual([noSsh.level, noSsh.detail, noSsh.fix], ['FAIL', 'me@central is saved, but ssh is not on PATH', 'Install the OpenSSH client (sudo apt install openssh-client)']);
  await m.file(join(m.bin, 'ssh'), '#!/bin/sh\necho "Host key verification failed." >&2\nexit 255\n');
  const saved = await m.run();
  assert.deepEqual(saved.filter(check => check.id === 'remote').map(shown), [`ok remote: me@central (${config}), running /opt/pi/bin/pi-durable there`,
    'skip remote login: pass --remote-check to try the SSH login']);
  const served = 'the server at me@central runs the chat; pi-durable doctor --local checks this machine\'s own';
  for (const id of ['model', 'agents', 'backups']) assert.deepEqual([one(saved, id).level, one(saved, id).detail], ['skip', served], id);
  assert.deepEqual(saved.map(check => check.id), [...IDS.slice(0, 12), 'remote', 'server']);

  // The real ssh runner, on a fake ssh: its stderr is the finding, and the link's own hint the fix.
  const refused = (await m.run(['--remote-check'], { ssh: undefined })).filter(check => check.id === 'remote')[1];
  assert.deepEqual(refused, { id: 'remote', level: 'FAIL', subject: 'remote login', detail: 'Host key verification failed.',
    fix: 'Run ssh me@central once to check and accept its host key; pi-durable never accepts one itself.' });
  await writeFile(join(m.bin, 'ssh'), '#!/bin/sh\nexec /bin/sleep 5\n');
  const hung = (await m.run(['--remote-check'], { ssh: undefined, remoteMs: 100 })).filter(check => check.id === 'remote')[1];
  assert.deepEqual(hung, { id: 'remote', level: 'warn', subject: 'remote login', detail: 'ssh me@central did not answer in 0.1 s',
    fix: 'Test it with ssh me@central true (docs/operations.md, Remote workstations over SSH)' });

  const calls: (readonly string[])[] = [];
  const ssh = (code: number, stderr = '') => (args: readonly string[], ms: number) => { calls.push([...args, String(ms)]); return Promise.resolve({ code, stderr, timedOut: false }); };
  const fine = (await m.run(['--remote-check'], { ssh: ssh(0) })).filter(check => check.id === 'remote')[1];
  assert.equal(shown(fine ?? assert.fail()), 'ok remote login: ssh me@central signs in without a prompt');
  assert.deepEqual(calls, [[...SSH_OPTIONS, '--', 'me@central', 'true', '10000']]);
  assert.ok(['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ClearAllForwardings=yes', 'ForwardAgent=no'].every(option => SSH_OPTIONS.includes(option)));
  const denied = (await m.run(['--remote-check'], { ssh: ssh(255, 'me@central: Permission denied (publickey).\n') })).filter(check => check.id === 'remote')[1];
  assert.equal(denied?.detail, 'me@central: Permission denied (publickey).');
  assert.match(denied?.fix ?? '', /^pi-durable signs in without prompts: set up key-based login for me@central/);
  const silent = (await m.run(['--remote-check'], { ssh: ssh(1) })).filter(check => check.id === 'remote')[1];
  assert.deepEqual([silent?.detail, silent?.fix], ['ssh exited with 1', 'Test it with ssh me@central true (docs/operations.md, Remote workstations over SSH)']);

  // --local is this machine's own chat, as for a launch.
  const local = await m.run(['--local', '--remote-check']);
  assert.equal(shown(one(local, 'remote')), 'skip remote: --local bypasses a saved remote');
  assert.deepEqual([one(local, 'model').level, one(local, 'backups').level], ['ok', 'warn']);
  // PI_DURABLE_REMOTE selects a server without the saved one's executable.
  m.env.PI_DURABLE_REMOTE = 'other';
  assert.equal(shown((await m.run()).filter(check => check.id === 'remote')[0] ?? assert.fail()), 'ok remote: other (PI_DURABLE_REMOTE), running pi-durable there');
  m.env.PI_DURABLE_REMOTE = '-oProxyCommand=bad';
  assert.equal(one(await m.run(), 'remote').detail, 'Invalid SSH host: use [user@]host (configure ports in ~/.ssh/config)');
  delete m.env.PI_DURABLE_REMOTE;
  await writeFile(config, '{"machineId":"nope"}');
  const invalid = await m.run();
  assert.deepEqual(one(invalid, 'remote'), { id: 'remote', level: 'FAIL', subject: 'remote',
    detail: `Invalid remote client configuration at ${config}: machineId must be a UUID; fix it or use --local`,
    fix: `Fix ${config}, then save the destination again if needed: pi-durable connect SSH_HOST (docs/operations.md, Remote workstations over SSH)` });
  assert.equal(one(invalid, 'model').level, 'ok', 'without a readable remote the chat is this machine\'s');
  await writeFile(config, JSON.stringify({ machineId }));
  assert.equal(one(await m.run(), 'remote').level, 'skip');
});

test('server: the web settings from the environment or the unit\'s environment file; half of them, or a bad origin, fails', async t => {
  const m = await machine(t), file = join(m.home, '.config', 'pi-durable', 'env');
  const docs = 'docs/operations.md, Web access over Tailscale';
  await m.file(join(m.home, '.config', 'systemd', 'user', 'pi-durable.service'), '[Service]\n', 0o600);
  assert.equal(shown(one(await m.run(), 'server')), 'ok server: the systemd unit is installed; socket only, no web app');
  // A shell on the server does not have what systemd reads from the file.
  await m.file(file, '# the web app\nPI_DURABLE_ORIGIN="https://vps.tailnet.ts.net"\n\n  PI_DURABLE_ALLOW_LOGIN=me@github\nPI_DURABLE_PORT=7500\nnot a line\n', 0o600);
  assert.deepEqual(one(await m.run(), 'server'), { id: 'server', level: 'warn', subject: 'server',
    detail: `web app at https://vps.tailnet.ts.net for me@github (${file}), but tailscale is not on PATH`,
    fix: `Install Tailscale, then tailscale serve --bg --https=443 http://127.0.0.1:7500 (${docs})` });
  await m.file(join(m.bin, 'tailscale'));
  assert.equal(shown(one(await m.run(), 'server')), `ok server: web app at https://vps.tailnet.ts.net for me@github (${file}); tailscale found`);
  await writeFile(file, 'PI_DURABLE_ORIGIN=https://vps.tailnet.ts.net\nPI_DURABLE_REMOTE_TOOLS=maybe\n');
  assert.deepEqual(one(await m.run(), 'server'), { id: 'server', level: 'FAIL', subject: 'server', detail: `PI_DURABLE_REMOTE_TOOLS must be confirm or off (${file})`,
    fix: `Fix the value in ${file}, then restart the server (docs/operations.md, The environment file)` });

  // The environment wins, and needs no unit.
  await rm(join(m.home, '.config'), { recursive: true });
  m.env.PI_DURABLE_ORIGIN = 'https://vps.tailnet.ts.net';
  assert.deepEqual(one(await m.run(), 'server'), { id: 'server', level: 'FAIL', subject: 'server',
    detail: 'the web app is off: PI_DURABLE_ORIGIN is set without PI_DURABLE_ALLOW_LOGIN (the environment)', fix: `Set both, or neither for socket only (${docs})` });
  delete m.env.PI_DURABLE_ORIGIN;
  m.env.PI_DURABLE_ALLOW_LOGIN = 'me@github';
  assert.equal(one(await m.run(), 'server').detail, 'the web app is off: PI_DURABLE_ALLOW_LOGIN is set without PI_DURABLE_ORIGIN (the environment)');
  m.env.PI_DURABLE_ORIGIN = 'http://vps.tailnet.ts.net';
  const origin = one(await m.run(), 'server');
  assert.deepEqual([origin.level, origin.detail], ['FAIL', 'PI_DURABLE_ORIGIN must be an origin like https://host.tailnet.ts.net (no path) (the environment)']);
});

test('a check that hangs is a warn saying so, one that throws a FAIL; the others still answer, and every problem has a fix', async t => {
  const m = await machine(t);
  await m.file(join(m.dataDir, 'chat.sqlite'), 'x', 0o600);
  // Standing agents on the catalog's own model, so their check reaches the credentials, which never answer.
  await m.file(join(m.dataDir, 'settings.json'), settingsOf(m.model), 0o600);
  const checks = await m.run([], { timeoutMs: 50, node: '20.0.0', sandbox: () => new Promise(() => {}), access: () => new Promise(() => {}),
    serverAnswers: () => Promise.reject(new Error('socket broke')) });
  const again = 'Run pi-durable doctor again; if it repeats, see docs/operations.md, Troubleshooting';
  assert.deepEqual(one(checks, 'sandbox'), { id: 'sandbox', level: 'warn', subject: 'bubblewrap', detail: 'the check did not finish in 0.05 s', fix: again });
  assert.deepEqual(one(checks, 'model'), { id: 'model', level: 'warn', subject: 'model', detail: 'the check did not finish in 0.05 s', fix: again });
  assert.deepEqual(one(checks, 'agents'), { id: 'agents', level: 'warn', subject: 'standing agents', detail: 'the check did not finish in 0.05 s', fix: again });
  assert.deepEqual(one(checks, 'chat'), { id: 'chat', level: 'FAIL', subject: 'chat', detail: 'socket broke', fix: again });
  assert.deepEqual(checks.map(check => check.id), IDS);
  assert.equal(one(checks, 'flock').level, 'ok');
  for (const check of checks) assert.equal(check.fix !== undefined, check.level === 'warn' || check.level === 'FAIL', shown(check));
});

test('doctorText: a line per check, Fix under a problem, a summary; colour only when asked', () => {
  const checks: Check[] = [
    { id: 'node', level: 'ok', subject: 'Node.js', detail: '22.23.1 (needs 22.19 or newer)' },
    { id: 'agents', level: 'warn', subject: 'standing agents', detail: 'Reviewer cannot browse', fix: 'npx --no-install playwright-core install chromium' },
    { id: 'model', level: 'FAIL', subject: 'model claude-cli/opus (--model)', detail: 'No Claude Code login', fix: 'claude auth login' },
    { id: 'server', level: 'skip', subject: 'server', detail: 'no systemd user unit and no web settings here' },
  ];
  assert.equal(doctorText(checks), [
    'ok    Node.js: 22.23.1 (needs 22.19 or newer)',
    'warn  standing agents: Reviewer cannot browse',
    '      Fix: npx --no-install playwright-core install chromium',
    'FAIL  model claude-cli/opus (--model): No Claude Code login',
    '      Fix: claude auth login',
    'skip  server: no systemd user unit and no web settings here',
    '1 problem, 1 warning.',
  ].join('\n'));
  assert.equal(doctorText(checks, { color: false }), doctorText(checks));
  assert.doesNotMatch(doctorText(checks), /\x1b/);
  assert.deepEqual(doctorText(checks, { color: true }).split('\n').filter(text => !text.startsWith(' ')).map(text => text.split(':')[0]), [
    '\x1b[2mok\x1b[0m    Node.js', '\x1b[33mwarn\x1b[0m  standing agents', '\x1b[31mFAIL\x1b[0m  model claude-cli/opus (--model)', '\x1b[2mskip\x1b[0m  server', '1 problem, 1 warning.']);
  const [ok, warning, failure] = checks;
  assert.ok(ok && warning && failure);
  assert.equal(doctorText([ok]).split('\n').at(-1), 'No problems.');
  assert.equal(doctorText([ok, warning, warning]).split('\n').at(-1), 'No problems, 2 warnings.');
  assert.equal(doctorText([failure, failure]).split('\n').at(-1), '2 problems.');
});

test('doctor: prints the report or, with --json, only the checks; its status is 1 when a check FAILs', async t => {
  const m = await machine(t), base = ['doctor', '--data-dir', m.dataDir, '--model', 'faux/faux-1'];
  const deps: DoctorDeps = { env: m.env, home: m.home, models: offlineModels().models, access: () => Promise.resolve({ ok: true }),
    sandbox: () => Promise.resolve(undefined), playwrightChromium: () => join(m.folder, 'chrome') };
  const printed: string[] = [];
  assert.equal(await doctor(parseArgs(base), deps, text => printed.push(text)), 0, 'warnings alone are status 0');
  assert.match(printed[0] ?? '', /^ok    Node\.js: .*\n(.*\n)*warn  standing agents: .*\n      Fix: .*\n(.*\n)*No problems, \d+ warnings\.$/);
  assert.doesNotMatch(printed[0] ?? '', /\x1b/);
  assert.equal(await doctor(parseArgs([...base, '--json']), { ...deps, node: '20.1.0' }, text => printed.push(text)), 1);
  assert.equal(printed.length, 2);
  const json: unknown = JSON.parse(printed[1] ?? '');
  assert.ok(Array.isArray(json));
  assert.deepEqual(json[0], { id: 'node', level: 'FAIL', subject: 'Node.js', detail: '20.1.0 (needs 22.19 or newer)', fix: 'Install a newer Node, or set PI_DURABLE_NODE to one' });
  assert.deepEqual(json[1], { id: 'flock', level: 'ok', subject: 'flock', detail: 'on PATH (a local chat and serve lock the chat with it)' });
  assert.deepEqual([...new Set(json.map((check: unknown) => (check as Check).id))], IDS);
});

/** A HOME and PATH for the real launcher: Node and the launcher's own tools, plus `tools` as executables that exit 0. */
async function launcherHome(t: { after(callback: () => Promise<void>): void }, tools: readonly string[]): Promise<{ folder: string; env: NodeJS.ProcessEnv }> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-doctor-cli-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bin = join(folder, 'bin'), home = join(folder, 'home');
  await Promise.all([bin, home].map(dir => mkdir(dir)));
  await symlink(process.execPath, join(bin, 'node'));
  for (const tool of ['readlink', 'dirname']) await symlink(`/usr/bin/${tool}`, join(bin, tool));
  for (const tool of tools) { await writeFile(join(bin, tool), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, tool), 0o755); }
  // Only this: no saved remote, data dir or model of the developer's reaches the launcher.
  return { folder, env: { HOME: home, PATH: bin, PI_DURABLE_CLIENT_CONFIG: join(folder, 'client.json') } };
}
const launch = (args: readonly string[], env: NodeJS.ProcessEnv) =>
  spawnSync('/bin/bash', [resolve('bin/pi-durable'), 'doctor', ...args], { encoding: 'utf8', env, timeout: 60_000 });

test('the launcher: a PATH without flock, bwrap or claude exits 1 and creates nothing', { timeout: 90_000 }, async t => {
  const { folder, env } = await launcherHome(t, []);
  const before = await snapshot(folder);
  const text = launch([], env);
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /^ok    Node\.js: /);
  assert.match(text.stdout, /^FAIL  flock: not on PATH; a local chat and serve cannot start\n      Fix: Install util-linux/m);
  assert.match(text.stdout, /^FAIL  bubblewrap: bash is off\. bwrap is not installed\./m);
  assert.match(text.stdout, /^FAIL  model openai-codex\/gpt-6\.1-sol \(the default\): No credentials for openai-codex\./m);
  assert.match(text.stdout, /^warn  standing agents: Standing agent Coder cannot run: No Claude Code login for claude-cli/m);
  assert.match(text.stdout, /^ok    chat: no saved chat yet /m);
  assert.match(text.stdout, /\n3 problems, \d+ warnings\.\n$/);
  assert.doesNotMatch(text.stdout, /\x1b/, 'no colour in a pipe');
  const json = launch(['--json'], env);
  assert.equal(json.status, 1, json.stderr);
  const checks: unknown = JSON.parse(json.stdout);
  assert.ok(Array.isArray(checks) && checks.length >= IDS.length);
  assert.deepEqual(await snapshot(folder), before, 'no data dir, auth file or client config appeared');
});

test('the launcher: a chat with its database is left byte for byte, and warnings alone exit 0', { timeout: 90_000 }, async t => {
  const { folder, env } = await launcherHome(t, ['flock', 'bwrap']);
  const dataDir = join(folder, 'state'), claude = join(folder, 'bin', 'claude-fake');
  await writeFile(claude, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n', { mode: 0o755 });
  await mkdir(join(dataDir, 'chat.unii', 'main'), { recursive: true });
  await mkdir(join(dataDir, 'backups', '2026-01-01T03-00-00Z'), { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'chat.sqlite'));
  database.exec('PRAGMA journal_mode = WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES (\'kept\')');
  database.close();
  await writeFile(join(dataDir, 'settings.json'), '{"model":"claude-cli/sonnet"}');
  await writeFile(join(dataDir, 'chat.unii', 'main', '2026-11-10.jsonl'), '{}\n');
  await writeFile(join(dataDir, 'chat.unii', 'view.json'), '{}');
  const before = await snapshot(folder);
  const run = launch(['--data-dir', dataDir], { ...env, PI_DURABLE_BWRAP: join(folder, 'bin', 'bwrap'), PI_DURABLE_CLAUDE_BIN: claude });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^ok    model claude-cli\/sonnet \(saved by \/model\): credentials found$/m);
  assert.match(run.stdout, new RegExp(`^ok    chat: ${join(dataDir, 'chat.sqlite')}, .*; no server answers on its socket$`, 'm'));
  assert.match(run.stdout, /^ok    memory: 1 day file in .*; view\.json parses$/m);
  assert.match(run.stdout, /^warn  backups: newest 2026-01-01T03-00-00Z, \d+ days old, in .*\n      Fix: pi-durable backup; /m);
  assert.match(run.stdout, /\nNo problems, \d+ warnings\.\n$/);
  assert.deepEqual(await snapshot(folder), before, 'the chat, its memory, settings and backups are untouched; no WAL, lock or socket appeared');
});

test('the launcher: a workstation with a saved remote still runs doctor, with options a remote chat refuses', { timeout: 90_000 }, async t => {
  const { folder, env } = await launcherHome(t, ['flock', 'bwrap', 'ssh']);
  await saveClientConfig({ machineId, ssh: { host: 'central' } }, env);
  const before = await snapshot(folder);
  const run = launch(['--data-dir', join(folder, 'state'), '--json'], { ...env, PI_DURABLE_BWRAP: join(folder, 'bin', 'bwrap') });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /not supported for remote chat|needs a terminal/);
  const checks: unknown = JSON.parse(run.stdout);
  assert.ok(Array.isArray(checks));
  const lines = checks.map((check: unknown) => shown(check as Check));
  assert.ok(lines.includes(`ok remote: central (${join(folder, 'client.json')}), running pi-durable there`), lines.join('\n'));
  assert.ok(lines.includes('skip remote login: pass --remote-check to try the SSH login'));
  assert.ok(lines.includes('skip model: the server at central runs the chat; pi-durable doctor --local checks this machine\'s own'));
  assert.deepEqual(await snapshot(folder), before);
});
