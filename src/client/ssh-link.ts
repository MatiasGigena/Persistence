// SSH carries the socket protocol on stdio; it never opens a forwarding listener.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isIP } from 'node:net';
import { isParseError, parseServerMessage } from '../protocol/parse.ts';
import { lineSplitter } from '../protocol/lines.ts';
import type { Channel, Connector } from './unix-link.ts';

export interface SshTarget {
  readonly host: string;
  /** One executable name/path, not a shell command. */
  readonly command?: string;
  /** Remote path, interpreted literally (no tilde or environment expansion). */
  readonly dataDir?: string;
}

export type SshSpawn = (command: string, args: string[], options: {
  stdio: ['pipe', 'pipe', 'pipe']; shell: false;
}) => ChildProcessWithoutNullStreams;

export interface SshOptions {
  readonly spawn?: SshSpawn;
  readonly signal?: AbortSignal;
  /** Time to the first welcome; 15 seconds by default, at most two minutes. */
  readonly startupMs?: number;
  /** SIGTERM to SIGKILL grace; one second by default. */
  readonly killMs?: number;
}

/** Snapshots can contain many items; still bound a broken/malicious remote stream. */
export const SSH_SERVER_LINE_MAX = 32 * 1024 * 1024;
const WRITE_MAX = 16 * 1024 * 1024;
const STDERR_MAX = 4096;
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
const clean = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 1024);

/**
 * How to fix a failed SSH start, from ssh's stderr and exit code, or ''. The connector runs ssh with BatchMode and strict
 * host keys, so a password prompt, a passphrase prompt or a new host key fails instead of asking.
 */
function fixHint(target: SshTarget, stderr: string, code: number | null): string {
  if (/Host key verification failed|host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return ` Run ssh ${target.host} once to check and accept its host key; pi-durable never accepts one itself.`;
  }
  // ssh's own "Permission denied (publickey,password)." only, not an EACCES the remote bridge reports.
  if (/Permission denied \(/.test(stderr)) {
    return ` pi-durable signs in without prompts: set up key-based login for ${target.host} (ssh-copy-id), and add a key with a passphrase to your ssh-agent.`;
  }
  if (code === 127 || /command not found|: not found/i.test(stderr)) {
    const executable = target.command ?? 'pi-durable';
    return ` ${executable} is not on the remote PATH of a noninteractive login: install it there, or name its full path with --remote-bin.`;
  }
  return '';
}

function remoteCommand(target: SshTarget): string {
  // Restrict destinations to aliases, DNS/IP addresses and an optional SSH username. In particular, no options,
  // whitespace, URI/port syntax, or shell metacharacters; ssh_config supplies ports and identity configuration.
  const invalidHost = (): never => { throw new Error('Invalid SSH host: use [user@]host (configure ports in ~/.ssh/config)'); };
  if (typeof target.host !== 'string' || target.host.length > 512) invalidHost();
  const parts = target.host.split('@');
  if (parts.length > 2 || (parts.length === 2 && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(parts[0] ?? ''))) invalidHost();
  const host = parts.at(-1) ?? '';
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (host.includes(':') ? isIP(address) !== 6 : !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) invalidHost();
  const executable = target.command ?? 'pi-durable';
  if (typeof executable !== 'string' || !executable.trim() || executable.startsWith('-')
    || executable.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(executable)) {
    throw new Error('Invalid SSH command: expected one executable name or path');
  }
  if (target.dataDir !== undefined && (typeof target.dataDir !== 'string' || !target.dataDir.trim()
    || target.dataDir.startsWith('-') || target.dataDir.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(target.dataDir))) {
    throw new Error('Invalid SSH data directory');
  }
  return [executable, 'bridge', ...target.dataDir === undefined ? [] : ['--data-dir', target.dataDir]].map(quote).join(' ');
}

/** Opens an authenticated, noninteractive SSH stdio channel to the existing remote Unix socket. */
export function sshConnector(target: SshTarget, options: SshOptions = {}): Connector {
  const command = remoteCommand(target);
  const startupMs = options.startupMs ?? 15_000, killMs = options.killMs ?? 1000;
  if (!Number.isInteger(startupMs) || startupMs < 1 || startupMs > 120_000
    || !Number.isInteger(killMs) || killMs < 1 || killMs > 30_000) throw new Error('Invalid SSH timeout');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    '--', target.host, command];
  return events => new Promise<Channel>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('SSH connection cancelled')); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawn ?? spawn)('ssh', [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch (error) { reject(error); return; }
    let settled = false, ended = false, welcomed = false, receivedBye = false, stderr = '';
    let startup: NodeJS.Timeout | undefined, killer: NodeJS.Timeout | undefined;
    const disposePipes = (): void => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
    const finish = (reason?: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(startup);
      options.signal?.removeEventListener('abort', cancelled);
      if (!settled) reject(new Error(reason ?? 'SSH connection closed'));
      else {
        // ChannelEvents has no transport-error callback. A local bye preserves concrete startup diagnostics in
        // ClientLink.start(), without changing the wire protocol or sending anything to the remote server.
        if (!welcomed && !receivedBye && reason) events.message(JSON.stringify({ t: 'bye', code: 1011, reason }));
        events.end();
      }
    };
    const stop = (reason?: string): void => {
      finish(reason);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!killer) killer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        disposePipes();
      }, killMs);
      killer.unref();
    };
    const cancelled = (): void => stop('SSH connection cancelled');
    const failure = (fallback: string, code: number | null = null): string => `SSH: ${clean(stderr) || fallback}${fixHint(target, stderr, code)}`;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, STDERR_MAX - stderr.length); });
    const split = lineSplitter(SSH_SERVER_LINE_MAX, line => {
      if (ended) return;
      if (!welcomed) {
        const message = parseServerMessage(line);
        if (!isParseError(message)) {
          if (message.t === 'welcome') { welcomed = true; clearTimeout(startup); }
          if (message.t === 'bye') receivedBye = true;
        }
      }
      events.message(line);
    }, () => stop('SSH server message exceeds the line limit'));
    child.stdout.on('data', (chunk: string) => { if (!ended) split(chunk); });
    child.stdin.on('error', error => stop(failure(error.message)));
    child.stdout.on('error', error => stop(failure(error.message)));
    child.stderr.on('error', () => undefined);
    child.once('error', error => stop(failure(error.message)));
    child.once('exit', () => {
      // An inherited pipe must not keep a dead SSH attempt alive indefinitely. Normally close follows at once.
      if (!killer) killer = setTimeout(() => { disposePipes(); finish(failure('connection closed')); }, killMs);
      killer.unref();
    });
    child.once('close', (code, signal) => {
      clearTimeout(killer);
      disposePipes();
      finish(failure(`connection closed (${signal ?? `exit ${code ?? 'unknown'}`})`, code));
    });
    options.signal?.addEventListener('abort', cancelled, { once: true });
    child.once('spawn', () => {
      if (ended) return;
      settled = true;
      resolve({
        send(text) {
          if (ended || !child.stdin.writable) return;
          const bytes = Buffer.byteLength(text) + 1;
          if (bytes + child.stdin.writableLength > WRITE_MAX) { stop('SSH write buffer limit exceeded'); return; }
          child.stdin.write(`${text}\n`);
        },
        close: () => stop(),
      });
    });
    startup = setTimeout(() => stop(failure('server did not answer hello in time')), startupMs);
    startup.unref();
  });
}
