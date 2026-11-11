// `pi-durable doctor` (ADR 0041): what this machine needs to run the host, each check with what is wrong and its fix.
// It runs in the CLI's process and only reads: no flock, no database connection, no model request, nothing created.
// A check calls what a launch itself calls (sandboxProblem, readSettings, checkAccess, rosterWarnings), so the two agree.
import { spawn } from 'node:child_process';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime, readStoredCredential } from '@earendil-works/pi-coding-agent';
import type { Roster } from '../agents/roster.ts';
import { formatBytes } from '../ui/text.ts';
import { serverAnswers } from '../client/attach.ts';
import { clientConfigPath, readClientConfig, validateTarget } from '../client/config.ts';
import { clean, fixHint, SSH_OPTIONS } from '../client/ssh-link.ts';
import type { SshTarget } from '../client/ssh-link.ts';
import { errorCode, errorMessage } from '../protocol/util.ts';
import { claudeCliProvider } from '../providers/claude-cli.ts';
import { bwrapBinary, protection, sandboxProblem, sshKeys } from '../runtime/guard.ts';
import type { Protection, StateFiles } from '../runtime/guard.ts';
import { accessProblem, catalogProblem, checkAccess } from '../runtime/models.ts';
import type { CredentialStatus, CatalogModels } from '../runtime/models.ts';
import { rosterWarnings } from '../runtime/runtime.ts';
import { SDK } from '../runtime/sdk.ts';
import { backupRoot, stampTime } from '../server/backup.ts';
import { resolveModel } from '../config/options.ts';
import type { ModelSource, Options } from '../config/options.ts';
import { chatLocation, chromiumPath, piAgentDir, serveSettings, statePaths } from '../config/paths.ts';
import type { ServeSettings } from '../config/paths.ts';
import { readRoster, readSettings } from '../config/settings.ts';
import type { Settings } from '../config/settings.ts';

export type Level = 'ok' | 'warn' | 'FAIL' | 'skip';

/** One line of the report. `skip` is a check that does not apply here; every `warn` and `FAIL` has a `fix`. */
export interface Check {
  readonly id: string;
  readonly level: Level;
  readonly subject: string;
  readonly detail: string;
  /** A command, or the doc section to read. */
  readonly fix?: string;
}

/** How an `ssh` run ended: its exit code (null when killed or not started) and stderr. */
export interface SshResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** What the checks use besides the file system; tests inject fakes. */
export interface DoctorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Default: `process.versions.node`. */
  readonly node?: string;
  readonly now?: number;
  /** Each check's limit; default 5 s. A check that takes longer is a `warn`. */
  readonly timeoutMs?: number;
  /** The `--remote-check` SSH login's limit; default 10 s. */
  readonly remoteMs?: number;
  /** Why bash cannot run under the protection, or undefined; default `sandboxProblem`. */
  readonly sandbox?: (guarded: Protection) => Promise<string | undefined>;
  /** The catalog; default the host's ModelRuntime, on a credential store that only reads. */
  readonly models?: CatalogModels;
  /** A provider's credentials; default `checkAccess` on `models`. */
  readonly access?: (provider: string) => Promise<CredentialStatus>;
  /** Playwright's Chromium path; default `rosterWarnings`' own. */
  readonly playwrightChromium?: () => string;
  /** Whether a server answers at the socket; default `serverAnswers`. */
  readonly serverAnswers?: (socket: string | undefined) => Promise<boolean>;
  /** Runs `ssh` with `args`, killing it after `timeoutMs`; default the real `ssh`. */
  readonly ssh?: (args: readonly string[], timeoutMs: number) => Promise<SshResult>;
}

/** settings.json as the launch reads it: `problem` is the first error; `roster` is absent when `agents` is invalid. */
interface Saved {
  readonly settings?: Settings;
  readonly roster?: Roster;
  readonly problem?: string;
}

/** The server a launch here would connect to (`remoteTarget` without --remote), or why it cannot be read. */
interface Remote {
  readonly target?: SshTarget;
  /** Where the destination is set: PI_DURABLE_REMOTE, or the client config's path. */
  readonly source: string;
  readonly problem?: string;
}

/** What every check reads: the resolved dependencies and the chat's paths, with nothing opened. */
interface Context extends Required<Pick<DoctorDeps, 'env' | 'home' | 'node' | 'now' | 'timeoutMs' | 'remoteMs' | 'sandbox' | 'serverAnswers' | 'ssh'>> {
  readonly options: Options;
  readonly state: StateFiles;
  readonly saved: Promise<Saved>;
  readonly remote: Promise<Remote>;
  readonly models: () => Promise<CatalogModels>;
  /** Each provider is checked once, for the launch model and the standing agents alike. */
  readonly access: (provider: string) => Promise<CredentialStatus>;
  readonly playwrightChromium?: (() => string) | undefined;
}

const INSTALL = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** A daily backup timer that missed a week. */
const STALE_BACKUP_MS = 8 * 24 * 60 * 60 * 1000;
const SOURCE: Readonly<Record<ModelSource, string>> = { flag: '--model', env: 'PI_DURABLE_MODEL', settings: 'saved by /model', default: 'the default' };

const line = (level: Level) => (id: string, subject: string, detail: string, fix?: string): Check =>
  ({ id, level, subject, detail, ...fix ? { fix } : {} });
const ok = line('ok'), skip = line('skip'), warn = line('warn'), fail = line('FAIL');

const can = (path: string, mode: number): Promise<boolean> => access(path, mode).then(() => true, () => false);
const isFile = (path: string): Promise<boolean> => stat(path).then(info => info.isFile(), () => false);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const ago = (ms: number): string => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min`
  : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;

/** Whether `name` is an executable file in a directory of `env.PATH`. */
export async function onPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const paths = (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, name));
  return (await Promise.all(paths.map(async path => await isFile(path) && can(path, constants.X_OK)))).some(Boolean);
}

/** `work`'s result, or `late()` when it takes over `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<T>(done => { timer = setTimeout(() => done(late()), ms); });
  try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
}

/**
 * The host's model runtime (src/host/host.ts) on a credential store that only reads Pi's auth file: the runtime's own
 * store creates a missing auth.json and takes its lock.
 */
async function hostModels(authFile: string, env: NodeJS.ProcessEnv, statusTimeoutMs: number): Promise<CatalogModels> {
  const refuse = (): Promise<never> => Promise.reject(new Error('pi-durable doctor never writes credentials'));
  const credentials: CredentialStore = { read: provider => Promise.resolve(readStoredCredential(provider, authFile)),
    list: () => Promise.resolve([]), modify: refuse, delete: refuse };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(claudeCliProvider({ env, statusTimeoutMs }));
  return runtime;
}

async function readSaved(path: string): Promise<Saved> {
  const [settings, roster] = await Promise.allSettled([readSettings(path), readRoster(path)]);
  const failed = settings.status === 'rejected' ? settings : roster.status === 'rejected' ? roster : undefined;
  return { ...settings.status === 'fulfilled' ? { settings: settings.value } : {}, ...roster.status === 'fulfilled' ? { roster: roster.value } : {},
    ...failed ? { problem: errorMessage(failed.reason) } : {} };
}

async function readRemote(options: Options, env: NodeJS.ProcessEnv): Promise<Remote> {
  const source = env.PI_DURABLE_REMOTE ? 'PI_DURABLE_REMOTE' : clientConfigPath(env);
  if (options.local) return { source };
  try {
    const saved = await readClientConfig(env);
    const target = env.PI_DURABLE_REMOTE ? validateTarget({ host: env.PI_DURABLE_REMOTE }) : saved?.ssh;
    return { source, ...target ? { target } : {} };
  } catch (error) {
    return { source, problem: errorMessage(error) };
  }
}

function runSsh(args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SshResult> {
  return new Promise(done => {
    const child = spawn('ssh', [...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const settle = (code: number | null): void => { clearTimeout(timer); done({ code, stderr, timedOut }); };
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096); });
    child.once('error', error => { stderr ||= error.message; settle(null); });
    child.once('close', code => settle(code));
  });
}

async function context(options: Options, deps: DoctorDeps): Promise<Context> {
  const env = deps.env ?? process.env, home = deps.home ?? homedir(), timeoutMs = deps.timeoutMs ?? 5_000;
  const { dataDir, databasePath } = await chatLocation(options, env);
  const paths = statePaths(databasePath, env);
  const state: StateFiles = { dataDir, databasePath, memoryDir: paths.memoryDir, settingsPath: paths.settings, serveDir: paths.serveDir,
    socketPath: paths.socket, authFile: resolve(options.authFile ?? join(piAgentDir(env, home), 'auth.json')) };
  let catalog: Promise<CatalogModels> | undefined;
  const models = (): Promise<CatalogModels> => catalog ??= deps.models ? Promise.resolve(deps.models) : hostModels(state.authFile, env, timeoutMs);
  const checked = new Map<string, Promise<CredentialStatus>>();
  const accessOf = (provider: string): Promise<CredentialStatus> => {
    const found = checked.get(provider) ?? (deps.access ? deps.access(provider) : models().then(all => checkAccess(all, provider, { timeoutMs })));
    checked.set(provider, found);
    return found;
  };
  return { options, env, home, timeoutMs, state, models, access: accessOf, saved: readSaved(paths.settings), remote: readRemote(options, env),
    node: deps.node ?? process.versions.node, now: deps.now ?? Date.now(), remoteMs: deps.remoteMs ?? 10_000,
    sandbox: deps.sandbox ?? (guarded => sandboxProblem(guarded, bwrapBinary(env, home))),
    serverAnswers: deps.serverAnswers ?? serverAnswers, ssh: deps.ssh ?? ((args, ms) => runSsh(args, ms, env)),
    playwrightChromium: deps.playwrightChromium };
}

function nodeCheck({ node }: Context): Check {
  const [major = 0, minor = 0] = node.split('.').map(Number);
  const detail = `${node} (needs 22.19 or newer)`;
  return major > 22 || (major === 22 && minor >= 19) ? ok('node', 'Node.js', detail)
    : fail('node', 'Node.js', detail, 'Install a newer Node, or set PI_DURABLE_NODE to one');
}

async function flockCheck({ env }: Context): Promise<Check> {
  return await onPath('flock', env) ? ok('flock', 'flock', 'on PATH (a local chat and serve lock the chat with it)')
    : fail('flock', 'flock', 'not on PATH; a local chat and serve cannot start', 'Install util-linux (sudo apt install util-linux)');
}

async function sandboxCheck({ sandbox, state, env, home }: Context): Promise<Check> {
  const problem = await sandbox(protection(state, env, home));
  if (!problem) return ok('sandbox', 'bubblewrap', 'bash runs in its sandbox');
  return fail('sandbox', 'bubblewrap', `bash is off. ${problem}`, /is not installed/.test(problem)
    ? 'sudo apt install bubblewrap (without root: the ~/.local/bin recipe in docs/operations.md, Requirements)'
    : 'Allow unprivileged user namespaces for bwrap (docs/operations.md, Troubleshooting)');
}

async function sshKeysCheck({ env, home }: Context): Promise<Check> {
  const keys = sshKeys(env, home);
  if (!keys.length) return skip('ssh-keys', 'SSH keys', 'PI_DURABLE_SSH_KEYS is not set');
  const tools = ['ssh-agent', 'ssh-add'];
  const [readable, found] = await Promise.all([Promise.all(keys.map(key => can(key, constants.R_OK))), Promise.all(tools.map(tool => onPath(tool, env)))]);
  const unreadable = keys.filter((_, index) => !readable[index]), missing = tools.filter((_, index) => !found[index]);
  if (!unreadable.length && !missing.length) return ok('ssh-keys', 'SSH keys', `${plural(keys.length, 'key')} readable; ssh-agent and ssh-add found`);
  const problems = [...unreadable.map(key => `${key} cannot be read`), ...missing.map(tool => `${tool} is not on PATH`)];
  return warn('ssh-keys', 'SSH keys', `${problems.join('; ')}. Pi's SSH agent will lack ${unreadable.length && !missing.length ? 'those keys' : 'its keys'}.`,
    missing.length ? 'Install the OpenSSH client (sudo apt install openssh-client)' : 'Fix the paths in PI_DURABLE_SSH_KEYS (docs/operations.md, Protected folders)');
}

async function settingsCheck({ saved, state }: Context): Promise<Check> {
  const { settings, problem } = await saved, path = state.settingsPath;
  if (problem) {
    return fail('settings', 'settings.json', problem,
      'Fix the file; it may hold a custom "agents" roster, so delete it only if it has none (docs/operations.md, Troubleshooting)');
  }
  if (!await isFile(path)) return ok('settings', 'settings.json', `none at ${path}; the defaults apply`);
  const { model, thinkingLevel, agents } = settings ?? {};
  const parts = [model && `model ${model.provider}/${model.modelId}`, thinkingLevel && `effort ${thinkingLevel}`,
    agents === undefined ? 'the built-in standing agents' : 'its own standing agents'];
  return ok('settings', 'settings.json', `${path}: ${parts.filter(Boolean).join(', ')}`);
}

const loginFix = (provider: string): string => provider === 'claude-cli' ? 'claude auth login'
  : provider === 'anthropic' ? 'Set ANTHROPIC_API_KEY to an Anthropic Console API key, or use --model claude-cli/sonnet (docs/models.md)'
    : `npm exec -- pi in ${INSTALL}, then /login; or set the provider's API-key variable, or pass --auth-file`;

/** Why a check of the chat's own needs does not apply on a workstation: a launch here opens the server's chat. */
const servedBy = ({ host }: SshTarget): string => `the server at ${host} runs the chat; pi-durable doctor --local checks this machine's own`;

async function modelCheck(context: Context): Promise<Check> {
  const { options, env, state } = context, { target } = await context.remote;
  if (target) return skip('model', 'model', servedBy(target));
  let launch: Awaited<ReturnType<typeof resolveModel>>;
  try { launch = await resolveModel(options, env, state.settingsPath); } catch (error) {
    // A settings.json that does not parse is the settings check's line.
    return (await context.saved).settings ? fail('model', 'model', errorMessage(error), 'Set PI_DURABLE_MODEL to PROVIDER/MODEL_ID, or unset it')
      : skip('model', 'model', 'settings.json must be fixed first');
  }
  const { model, modelSource } = launch, subject = `model ${model.provider}/${model.modelId} (${SOURCE[modelSource]})`;
  const unknown = catalogProblem(await context.models(), model);
  if (unknown) return fail('model', subject, unknown, `Pick a model from the Pi ${SDK} catalog; check PI_DURABLE_MODEL and settings.json (docs/models.md)`);
  const found = await context.access(model.provider), problem = accessProblem(model, found, state.authFile);
  if (!problem) return ok('model', subject, 'credentials found');
  return (!found.ok && found.reason === 'timeout' ? warn : fail)('model', subject, problem, loginFix(model.provider));
}

async function agentsCheck(context: Context): Promise<Check | Check[]> {
  const subject = 'standing agents', { roster } = await context.saved, { target } = await context.remote;
  if (target) return skip('agents', subject, servedBy(target));
  if (!roster) return skip('agents', subject, 'settings.json must be fixed first');
  const names = Object.entries(roster).map(([name, { model }]) => `${name} (${model.provider}/${model.modelId})`);
  if (!names.length) return ok('agents', subject, 'settings.json has none');
  let chromium: string | undefined;
  try { chromium = chromiumPath(context.env); } catch (error) {
    return fail('agents', subject, errorMessage(error), 'Set PI_DURABLE_CHROMIUM to an absolute path, or unset it for Playwright\'s Chromium');
  }
  const warnings = await rosterWarnings(roster, { models: await context.models(), chromium, authFile: context.state.authFile,
    timeoutMs: context.timeoutMs, access: provider => context.access(provider),
    ...context.playwrightChromium ? { defaultChromium: context.playwrightChromium } : {} });
  if (!warnings.length) return ok('agents', subject, `${names.join(', ')} can run`);
  return warnings.map(message => warn('agents', subject, message, /cannot browse/.test(message)
    ? `npx --no-install playwright-core install chromium in ${INSTALL}, or set PI_DURABLE_CHROMIUM`
    : 'Sign in to that provider, or set another model for the agent in settings.json\'s "agents" (docs/operations.md, Troubleshooting)'));
}

async function autoreviewCheck({ saved, env, home }: Context): Promise<Check> {
  const subject = 'autoreview', { roster } = await saved;
  if (!roster) return skip('autoreview', subject, 'settings.json must be fixed first');
  const reviewers = Object.entries(roster).filter(([, agent]) => agent.tools.includes('autoreview')).map(([name]) => name);
  if (!reviewers.length) return skip('autoreview', subject, 'no standing agent has the autoreview kit');
  // The paths src/tools/autoreview.ts runs: the skill under Pi's directory, python3, and the Codex CLI it names itself.
  const skill = join(piAgentDir(env, home), 'skills', 'autoreview'), codex = join(home, '.local', 'share', 'autoreview', 'codex-cli', 'bin', 'codex');
  const [manual, helper, python, cli] = await Promise.all([can(join(skill, 'SKILL.md'), constants.R_OK),
    can(join(skill, 'scripts', 'autoreview'), constants.R_OK), onPath('python3', env), can(codex, constants.X_OK)]);
  const missing = [!manual && `${join(skill, 'SKILL.md')} is missing`, !helper && `${join(skill, 'scripts', 'autoreview')} is missing`,
    !python && 'python3 is not on PATH', !cli && `the standalone Codex CLI is not at ${codex}`].filter(Boolean);
  return missing.length ? warn('autoreview', subject, `${reviewers.join(', ')} cannot review code here: ${missing.join('; ')}`,
    'Install the skill and the Codex CLI on each machine where reviews run (docs/operations.md, Autoreview)')
    : ok('autoreview', subject, `the skill at ${skill}, python3 and the Codex CLI found`);
}

async function chatCheck({ state, serverAnswers: answers }: Context): Promise<Check> {
  const path = state.databasePath, info = await stat(path).catch(() => undefined);
  if (!info) return ok('chat', 'chat', `no saved chat yet (${path})`);
  if (!info.isFile()) return fail('chat', 'chat', `${path} is not a file, so no chat can open there`, 'Move it away, or name the database with --database');
  const server = await answers(state.socketPath) ? `a server runs this chat (${state.socketPath ?? ''})` : 'no server answers on its socket';
  return ok('chat', 'chat', `${path}, ${formatBytes(info.size)}; ${server}`);
}

async function memoryCheck({ state }: Context): Promise<Check> {
  const dir = state.memoryDir, log = join(dir, 'main'), restore = 'Restore chat.unii/ from a backup (docs/operations.md, Backups)';
  if (!await can(dir, constants.F_OK)) return skip('memory', 'memory', `no memory yet (${dir})`);
  let days: number;
  try { days = (await readdir(log)).filter(name => name.endsWith('.jsonl')).length; } catch (error) {
    return fail('memory', 'memory', `the log ${log} cannot be read (${errorMessage(error)})`, restore);
  }
  const found = `${plural(days, 'day file')} in ${log}`;
  try { JSON.parse(await readFile(join(dir, 'view.json'), 'utf8')); } catch (error) {
    if (errorCode(error) === 'ENOENT') return ok('memory', 'memory', `${found}; no view.json yet`);
    return warn('memory', 'memory', `${found}; view.json cannot be read (${errorMessage(error)}), so the next launch folds the log again`,
      `Nothing to do if the next launch opens; if its view is wrong, ${restore.replace('Restore', 'restore')}`);
  }
  return ok('memory', 'memory', `${found}; view.json parses`);
}

async function backupsCheck({ state, now, remote }: Context): Promise<Check> {
  const root = backupRoot(state.databasePath), { target } = await remote;
  if (target) return skip('backups', 'backups', servedBy(target));
  if (!await isFile(state.databasePath)) return skip('backups', 'backups', 'no saved chat to back up');
  const names = await readdir(root).catch(() => []);
  const newest = names.flatMap(name => { const time = stampTime(name); return time === undefined ? [] : [{ name, time }]; })
    .sort((a, b) => b.time - a.time)[0];
  const fix = 'pi-durable backup; for a daily one, the timer in contrib/systemd/ (docs/operations.md, Backups)';
  if (!newest) return warn('backups', 'backups', `no backup in ${root}`, fix);
  const age = now - newest.time, found = `newest ${newest.name}, ${ago(age)} old, in ${root}`;
  return age > STALE_BACKUP_MS ? warn('backups', 'backups', found, fix) : ok('backups', 'backups', found);
}

async function remoteCheck({ env, options, ssh, remoteMs, remote }: Context): Promise<Check | Check[]> {
  const { target, source, problem } = await remote, docs = 'docs/operations.md, Remote workstations over SSH';
  if (problem) return fail('remote', 'remote', problem, `Fix ${source}, then save the destination again if needed: pi-durable connect SSH_HOST (${docs})`);
  if (!target) return skip('remote', 'remote', options.local ? '--local bypasses a saved remote' : 'no remote server is saved (pi-durable connect SSH_HOST saves one)');
  if (!await onPath('ssh', env)) return fail('remote', 'remote', `${target.host} is saved, but ssh is not on PATH`, 'Install the OpenSSH client (sudo apt install openssh-client)');
  const named = ok('remote', 'remote', `${target.host} (${source}), running ${target.command ?? 'pi-durable'} there`);
  if (!options.remoteCheck) return [named, skip('remote', 'remote login', 'pass --remote-check to try the SSH login')];
  // The link's own options (BatchMode, strict host keys, no forwarding) with a command that does nothing.
  const { code, stderr, timedOut } = await ssh([...SSH_OPTIONS, '--', target.host, 'true'], remoteMs);
  const test = `Test it with ssh ${target.host} true (${docs})`;
  if (timedOut) return [named, warn('remote', 'remote login', `ssh ${target.host} did not answer in ${remoteMs / 1000} s`, test)];
  return [named, code === 0 ? ok('remote', 'remote login', `ssh ${target.host} signs in without a prompt`)
    : fail('remote', 'remote login', clean(stderr) || `ssh exited with ${String(code)}`, fixHint(target, stderr, code).trim() || test)];
}

/** The `NAME=value` lines of a systemd EnvironmentFile, one pair of quotes removed; {} when there is no file. */
async function environmentFile(path: string): Promise<NodeJS.ProcessEnv> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return Object.fromEntries(text.split('\n').flatMap(each => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(each);
    return match ? [[match[1] ?? '', (match[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')]] : [];
  }));
}

async function serverCheck({ env, home }: Context): Promise<Check> {
  const unit = join(home, '.config', 'systemd', 'user', 'pi-durable.service'), file = join(home, '.config', 'pi-durable', 'env');
  const here = Boolean(env.PI_DURABLE_ORIGIN || env.PI_DURABLE_ALLOW_LOGIN), installed = await isFile(unit);
  if (!installed && !here) return skip('server', 'server', 'no systemd user unit and no web settings here');
  // A shell on the server lacks the settings systemd reads from the unit's EnvironmentFile.
  const source = here ? 'the environment' : file, docs = 'docs/operations.md, Web access over Tailscale';
  let settings: ServeSettings;
  try { settings = serveSettings({}, here ? env : { ...await environmentFile(file), ...env }); } catch (error) {
    return fail('server', 'server', `${errorMessage(error)} (${source})`, `Fix the value in ${source}, then restart the server (docs/operations.md, The environment file)`);
  }
  const { origin, allowLogins, port } = settings;
  if (!origin && !allowLogins.length) return ok('server', 'server', 'the systemd unit is installed; socket only, no web app');
  if (!origin || !allowLogins.length) {
    return fail('server', 'server', `the web app is off: ${origin ? 'PI_DURABLE_ORIGIN' : 'PI_DURABLE_ALLOW_LOGIN'} is set without `
      + `${origin ? 'PI_DURABLE_ALLOW_LOGIN' : 'PI_DURABLE_ORIGIN'} (${source})`, `Set both, or neither for socket only (${docs})`);
  }
  const web = `web app at ${origin} for ${allowLogins.join(', ')} (${source})`;
  return await onPath('tailscale', env) ? ok('server', 'server', `${web}; tailscale found`)
    : warn('server', 'server', `${web}, but tailscale is not on PATH`, `Install Tailscale, then tailscale serve --bg --https=443 http://127.0.0.1:${port} (${docs})`);
}

/** The checks in output order. `limit` is a check's own time limit, when it is not the default. */
const CHECKS: readonly { id: string; subject: string; run: (context: Context) => Check | Promise<Check | Check[]>; limit?: (context: Context) => number }[] = [
  { id: 'node', subject: 'Node.js', run: nodeCheck },
  { id: 'flock', subject: 'flock', run: flockCheck },
  { id: 'sandbox', subject: 'bubblewrap', run: sandboxCheck },
  { id: 'ssh-keys', subject: 'SSH keys', run: sshKeysCheck },
  { id: 'settings', subject: 'settings.json', run: settingsCheck },
  { id: 'model', subject: 'model', run: modelCheck },
  { id: 'agents', subject: 'standing agents', run: agentsCheck },
  { id: 'autoreview', subject: 'autoreview', run: autoreviewCheck },
  { id: 'chat', subject: 'chat', run: chatCheck },
  { id: 'memory', subject: 'memory', run: memoryCheck },
  { id: 'backups', subject: 'backups', run: backupsCheck },
  { id: 'remote', subject: 'remote', run: remoteCheck, limit: ({ options, remoteMs, timeoutMs }) => options.remoteCheck ? remoteMs + timeoutMs : timeoutMs },
  { id: 'server', subject: 'server', run: serverCheck },
];

/**
 * Every check for the launch `options` name, run at once and listed in a fixed order. Never opens the chat and creates
 * nothing. A check that throws is a FAIL with the error; one that takes over its limit is a `warn` saying so.
 */
export async function runDoctor(options: Options, deps: DoctorDeps = {}): Promise<Check[]> {
  const shared = await context(options, deps);
  const again = 'Run pi-durable doctor again; if it repeats, see docs/operations.md, Troubleshooting';
  const results = await Promise.all(CHECKS.map(({ id, subject, run, limit }) => {
    const ms = limit?.(shared) ?? shared.timeoutMs;
    const work = (async () => run(shared))().catch((error: unknown) => fail(id, subject, errorMessage(error), again));
    return withTimeout(work, ms, () => warn(id, subject, `the check did not finish in ${ms / 1000} s`, again));
  }));
  return results.flat();
}

const PAINT: Readonly<Record<Level, string>> = { ok: '2', skip: '2', warn: '33', FAIL: '31' };

/** The report: a line per check (level, subject, what was found), `Fix:` under a warn or FAIL, then a summary. `color` paints the levels. */
export function doctorText(checks: readonly Check[], { color = false }: { color?: boolean } = {}): string {
  const lines = checks.flatMap(({ level, subject, detail, fix }) => [
    `${color ? `\x1b[${PAINT[level]}m${level}\x1b[0m` : level}${' '.repeat(6 - level.length)}${subject}: ${detail}`,
    ...fix ? [`      Fix: ${fix}`] : []]);
  const count = (level: Level): number => checks.filter(check => check.level === level).length;
  const problems = count('FAIL'), warnings = count('warn');
  return [...lines, `${problems ? plural(problems, 'problem') : 'No problems'}${warnings ? `, ${plural(warnings, 'warning')}` : ''}.`].join('\n');
}

/** `pi-durable doctor`: prints the report, or the checks as JSON with --json; resolves with the exit status, 1 when a check FAILs. */
export async function doctor(options: Options, deps: DoctorDeps = {}, print: (text: string) => void = console.log): Promise<number> {
  const checks = await runDoctor(options, deps);
  print(options.json ? JSON.stringify(checks, null, 2) : doctorText(checks, { color: process.stdout.isTTY && !process.env.NO_COLOR }));
  return checks.some(check => check.level === 'FAIL') ? 1 : 0;
}
