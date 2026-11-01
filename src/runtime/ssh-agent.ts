// Pi's own SSH agent (ADR 0030). bash never sees the user's agents (guard.ts), which sign with every key they hold;
// with PI_DURABLE_SSH_KEYS it sees this one, holding only those keys, so `git push` works while every key file stays
// hidden from the tools.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface SshAgent {
  /** For SSH_AUTH_SOCK. */
  readonly socket: string;
  /** Stop the agent and remove its folder. */
  close(): Promise<void>;
}

/** A Unix socket path's limit on Linux, in bytes. */
const MAX_SOCKET = 107;

/** Why `command` failed: ENOENT as not installed, else its last stderr line. */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise(done => {
    // detached: no controlling terminal, so a key's passphrase prompt fails instead of taking over the user's.
    const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', error => done('code' in error && error.code === 'ENOENT' ? `${command} is not installed` : error.message));
    child.once('close', code => done(code === 0 ? undefined : stderr.trim().split('\n').at(-1) || `${command} exited with ${String(code)}`));
  });
}

/**
 * Starts `ssh-agent` on a socket in a private folder (under XDG_RUNTIME_DIR, else /tmp) and adds `keys`. Never
 * throws: each problem goes to `warn`. Undefined without keys, or when the agent cannot start. A key with a
 * passphrase is not added, since nothing can ask for it.
 */
export async function startSshAgent(keys: readonly string[], warn: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env): Promise<SshAgent | undefined> {
  if (!keys.length) return undefined;
  let dir: string;
  try { dir = await mkdtemp(join(env.XDG_RUNTIME_DIR || '/tmp', 'pi-ssh-')); } catch (error) {
    warn(`Pi's SSH agent is off: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const socket = join(dir, 'agent');
  const fail = async (why: string): Promise<undefined> => {
    await rm(dir, { recursive: true, force: true });
    warn(`Pi's SSH agent is off, so bash has none: ${why}`);
    return undefined;
  };
  if (Buffer.byteLength(socket) > MAX_SOCKET) return fail(`its socket path ${socket} is over ${MAX_SOCKET} bytes`);
  const agent = spawn('ssh-agent', ['-D', '-a', socket], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // -D stays in the foreground and prints SSH_AUTH_SOCK once it listens.
  const problem = await new Promise<string | undefined>(done => {
    let stderr = '';
    const timer = setTimeout(() => done('ssh-agent did not start in 5 s'), 5_000);
    const settle = (why: string | undefined): void => { clearTimeout(timer); done(why); };
    agent.stdout.once('data', () => settle(undefined));
    agent.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    agent.once('error', error => settle('code' in error && error.code === 'ENOENT' ? 'ssh-agent is not installed' : error.message));
    agent.once('exit', code => settle(stderr.trim().split('\n').at(-1) || `ssh-agent exited with ${String(code)}`));
  });
  agent.stdout.resume();
  const exited = agent.exitCode !== null || agent.signalCode !== null ? Promise.resolve()
    : new Promise<void>(done => agent.once('exit', () => done()));
  const close = async (): Promise<void> => {
    agent.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  };
  if (problem) {
    await close();
    return fail(problem);
  }
  const addEnv = { ...env, SSH_AUTH_SOCK: socket, SSH_ASKPASS_REQUIRE: 'never' };
  for (const key of keys) {
    const notAdded = `PI_DURABLE_SSH_KEYS: ${key} is not in Pi's SSH agent`;
    if (!existsSync(key)) { warn(`${notAdded}: there is no such file.`); continue; }
    const why = await run('ssh-add', ['-q', '--', key], addEnv);
    // ssh-add asks for a passphrase it cannot get ("Enter passphrase for …"); say so plainly, and only then.
    if (why) warn(/passphrase/i.test(why) ? `${notAdded}: it has a passphrase, which nothing can ask for here. Use a key without one.` : `${notAdded} (${why}).`);
  }
  return { socket, close };
}
