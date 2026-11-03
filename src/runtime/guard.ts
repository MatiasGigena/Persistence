// Protected folders for Pi's coding tools (ADR 0025). The chat's own state and the user's credentials are hidden:
// the tools can neither read nor change them. System folders are read-only. read, write and edit are checked here, by
// real path (symlinks followed); every bash command runs in bubblewrap, where hidden folders are empty and system
// folders are mounted read-only, so the shell is held to the same rules. The user's SSH and GPG agents are hidden too, since
// an agent signs with every key it holds; bash sees only Pi's own agent (src/runtime/ssh-agent.ts, ADR 0030), if any.
import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { err, ExecutionError, FileError } from '@earendil-works/pi-durable/env';
import type { BinaryReader, DirReader, ExecutionError as ExecError, FileWatcher, Result,
  ShellExecOptions, ShellExecResult, TextLineReader, WatchChange, WatchTarget } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

/** What the tools may not touch: `hidden` neither read nor written, `readOnly` read only. Absolute paths. */
export interface Protection {
  readonly hidden: readonly string[];
  readonly readOnly: readonly string[];
  /** The socket of Pi's own SSH agent: bash's only SSH_AUTH_SOCK. Without it bash has none. */
  readonly sshAgent?: string | undefined;
}

/** The chat's files, as the host's config names them. */
export interface StateFiles {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly memoryDir: string;
  readonly settingsPath: string;
  readonly serveDir: string;
  readonly socketPath?: string | undefined;
  readonly authFile: string;
}

/** Credentials under the home directory, relative to it. */
const CREDENTIALS = ['.ssh', '.gnupg', '.claude', '.claude.json', '.pi/agent/auth.json', '.config/gh', '.aws', '.azure',
  '.config/gcloud', '.kube', '.docker/config.json', '.netrc', '.git-credentials', '.npmrc', '.pypirc'];
/**
 * The bubblewrap binary: PI_DURABLE_BWRAP, else `~/.local/bin/bwrap` when there (installed without root, from the
 * package's .deb), else `bwrap` on PATH.
 */
export function bwrapBinary(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const local = join(home, '.local', 'bin', 'bwrap');
  return env.PI_DURABLE_BWRAP || (existsSync(local) ? local : 'bwrap');
}

const SYSTEM = ['/etc', '/usr', '/boot', '/opt', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/srv', '/var/lib'];

const expand = (path: string, home: string): string => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);
const list = (value: string | undefined, home: string): string[] =>
  (value ?? '').split(':').map(each => each.trim()).filter(Boolean).map(each => resolve(expand(each, home)));

/**
 * The default protection: the chat's state (database and its WAL, lock and socket, memory, settings, server files,
 * backups) and credentials hidden, system folders read-only. PI_DURABLE_PROTECT adds hidden paths and
 * PI_DURABLE_UNPROTECT removes defaults, each a `:`-separated list where `~` is the home directory.
 */
export function protection(state: StateFiles, env: NodeJS.ProcessEnv = process.env, home = homedir()): Protection {
  const db = state.databasePath;
  const chat = [state.dataDir, db, `${db}-wal`, `${db}-shm`, `${db}-journal`, `${db}.lock`, `${db}.sock`, state.memoryDir,
    state.settingsPath, state.serveDir, join(dirname(db), 'backups'), ...state.socketPath ? [state.socketPath] : []];
  const unprotect = new Set(list(env.PI_DURABLE_UNPROTECT, home));
  const keep = (path: string): boolean => !unprotect.has(resolve(path));
  // The user's agents: the SSH agent, GNOME Keyring's folder (its SSH agent and secrets) and gpg-agent's sockets.
  const runtime = env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, 'keyring'), join(env.XDG_RUNTIME_DIR, 'gnupg')] : [];
  const agents = [...env.SSH_AUTH_SOCK ? [env.SSH_AUTH_SOCK] : [], ...runtime];
  const hidden = [...chat, state.authFile, ...CREDENTIALS.map(path => join(home, path)), ...agents, ...list(env.PI_DURABLE_PROTECT, home)];
  return { hidden: [...new Set(hidden.map(path => resolve(path)))].filter(keep), readOnly: SYSTEM.filter(keep) };
}

/** PI_DURABLE_SSH_KEYS: the private keys Pi's own SSH agent holds, `:`-separated, `~` the home directory. */
export function sshKeys(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return list(env.PI_DURABLE_SSH_KEYS, home);
}

/** `path` with symlinks resolved as far as it exists; the rest appended as given. */
async function real(path: string): Promise<string> {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try { return join(await realpath(head), ...tail); } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

type Access = 'read' | 'write' | 'remove';

/** Bubblewrap's argv prefix for `protection`, from what exists now: hidden folders become empty, hidden files unreadable. */
async function sandboxArgs(bin: string, { hidden, readOnly, sshAgent }: Protection): Promise<string[]> {
  const args = [bin, '--die-with-parent', '--dev-bind', '/', '/', '--unsetenv', 'SSH_AGENT_PID',
    ...sshAgent ? ['--setenv', 'SSH_AUTH_SOCK', sshAgent] : ['--unsetenv', 'SSH_AUTH_SOCK']];
  // A path inside a hidden folder is hidden with it; mounting it too would show its name in the empty folder.
  const outermost = hidden.filter(path => !hidden.some(other => other !== path && within(path, other)));
  const stat = (path: string) => lstat(path).catch(() => undefined);
  const [readOnlyInfo, hiddenInfo] = await Promise.all([Promise.all(readOnly.map(stat)), Promise.all(outermost.map(stat))]);
  readOnly.forEach((path, index) => {
    // A symlink (/bin -> usr/bin) is covered by its target.
    if (readOnlyInfo[index]?.isDirectory()) args.push('--ro-bind', path, path);
  });
  for (const [index, path] of outermost.entries()) {
    const info = hiddenInfo[index];
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) args.push('--tmpfs', path);
    else args.push('--ro-bind', '/dev/null', path);
  }
  return [...args, '--'];
}

/**
 * The likely cause when bubblewrap is refused a user namespace ("setting up uid map: Permission denied", "Operation not
 * permitted"), unless its own text already names the sysctl: the user, not Pi, can allow them.
 */
const namespaceHint = (stderr: string): string => /uid map|namespace|not permitted|Permission denied/i.test(stderr) && !/sysctl/.test(stderr)
  ? '. Unprivileged user namespaces are likely off (on Ubuntu 24.04, AppArmor\'s kernel.apparmor_restrict_unprivileged_userns); '
    + 'allow them for bwrap: see Troubleshooting in docs/operations.md.'
  : '';

/** Why bubblewrap cannot run here, or undefined when it can; asked once per argv prefix. */
const probes = new Map<string, Promise<string | undefined>>();
function probe(args: readonly string[]): Promise<string | undefined> {
  const key = args.join('\0');
  let found = probes.get(key);
  if (!found) {
    const [bin = 'bwrap', ...rest] = args;
    found = new Promise(done => execFile(bin, [...rest, '/bin/sh', '-c', 'true'], { timeout: 10_000 }, (error, _out, stderr) => {
      if (!error) return done(undefined);
      const missing = 'code' in error && error.code === 'ENOENT';
      done(missing ? `${bin} is not installed. Install bubblewrap (sudo apt install bubblewrap, or without root its .deb's`
        + ' usr/bin/bwrap into ~/.local/bin) and restart Pi Durable.'
        : `bubblewrap cannot run here: ${stderr.trim().split('\n').at(-1) ?? error.message}${namespaceHint(stderr)}`);
    }));
    probes.set(key, found);
  }
  return found;
}

/** `guarded` with its protected paths' symlinks resolved, all at once. */
async function canonicalOf(guarded: Protection): Promise<Protection> {
  const [hidden, readOnly] = await Promise.all([Promise.all(guarded.hidden.map(real)), Promise.all(guarded.readOnly.map(real))]);
  return { hidden, readOnly, sshAgent: guarded.sshAgent };
}

/** Why bash cannot run under `guarded` on this machine, or undefined when it can: checked at launch, so it is said early. */
export async function sandboxProblem(guarded: Protection, bwrap = bwrapBinary()): Promise<string | undefined> {
  return probe(await sandboxArgs(bwrap, await canonicalOf(guarded)));
}

export interface GuardedEnvOptions {
  readonly cwd: string;
  readonly protection: Protection;
  /** The bubblewrap binary; default bwrapBinary(). */
  readonly bwrap?: string;
}

/**
 * NodeExecutionEnv with `protection` enforced. File operations on a hidden path, writes to a read-only one, and
 * removing or renaming anything that contains a protected path fail with `permission_denied`. bash runs in bubblewrap;
 * without a working bubblewrap it refuses to run, saying how to install it.
 */
export class GuardedEnv extends NodeExecutionEnv {
  private readonly guarded: Protection;
  private readonly bin: string;
  private roots: Promise<Protection> | undefined;
  private shell: Promise<string> | undefined;

  constructor({ cwd, protection: guarded, bwrap = bwrapBinary() }: GuardedEnvOptions) {
    super({ cwd });
    this.guarded = guarded;
    this.bin = bwrap;
  }

  /** The protected paths with symlinks resolved, computed once. */
  private canonical(): Promise<Protection> {
    this.roots ??= canonicalOf(this.guarded);
    return this.roots;
  }

  /** The refusal for `access` to `path`, or undefined when it is allowed. */
  private async refusal(path: string, mode: Access): Promise<FileError | undefined> {
    const [target, { hidden, readOnly }] = await Promise.all([real(isAbsolute(path) ? path : resolve(this.cwd, path)), this.canonical()]);
    const deny = (root: string, why: string): FileError =>
      new FileError('permission_denied', `${path} is protected (${root}): ${why}. The user can change this with PI_DURABLE_UNPROTECT.`, path);
    for (const root of hidden) if (within(target, root)) return deny(root, 'Pi\'s tools cannot read or change it');
    if (mode === 'read') return undefined;
    for (const root of readOnly) if (within(target, root)) return deny(root, 'it is read-only for Pi\'s tools');
    if (mode === 'remove') {
      for (const root of [...hidden, ...readOnly]) if (within(root, target)) return deny(root, 'it is inside, and Pi\'s tools cannot remove or move it');
    }
    return undefined;
  }

  private async guard<T>(path: string, mode: Access, run: () => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    const refused = await this.refusal(path, mode);
    return refused ? err(refused) : run();
  }

  override readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.guard(path, 'read', () => super.readTextFile(path, context));
  }
  override openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.guard(path, 'read', () => super.openTextLineReader(path, context));
  }
  override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.guard(path, 'read', () => super.readTextLines(path, options, context));
  }
  override readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.guard(path, 'read', () => super.readBinaryFile(path, context));
  }
  override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.guard(path, 'read', () => super.openBinaryReader(path, options, context));
  }
  override listDir(path: string, context: Context): ReturnType<NodeExecutionEnv['listDir']> {
    return this.guard(path, 'read', () => super.listDir(path, context));
  }
  override openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.guard(path, 'read', () => super.openDirReader(path, context));
  }
  override async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const refused = (await Promise.all(targets.map(({ path }) => this.refusal(path, 'read')))).find(each => each !== undefined);
    if (refused) return err(refused);
    return super.watch(targets, onChange, context);
  }
  override writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'write', () => super.writeFile(path, content, context));
  }
  override appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'write', () => super.appendFile(path, content, context));
  }
  override truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'write', () => super.truncateFile(path, size, context));
  }
  override flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'write', () => super.flushFile(path, context));
  }
  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const [source, destination] = await Promise.all([this.refusal(sourcePath, 'remove'), this.refusal(destinationPath, 'remove')]);
    const refused = source ?? destination;
    return refused ? err(refused) : super.renameFile(sourcePath, destinationPath, context);
  }
  override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'write', () => super.createDir(path, options, context));
  }
  override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.guard(path, 'remove', () => super.remove(path, options, context));
  }

  /** Every command runs in bubblewrap with the protection mounted; a string through bash (sh without it), as upstream. */
  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecError>> {
    this.shell ??= access('/bin/bash', constants.X_OK).then(() => '/bin/bash', () => '/bin/sh');
    const prefix = await sandboxArgs(this.bin, await this.canonical());
    const [problem, shell] = await Promise.all([probe(prefix), this.shell]);
    if (problem) return err(new ExecutionError('shell_unavailable', `bash is off: ${problem}`));
    const argv = typeof command === 'string' ? [...prefix, shell, '-c', command] : [...prefix, ...command];
    return super.exec(argv, options, context);
  }
}
