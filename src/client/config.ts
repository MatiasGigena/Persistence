// Client preferences are independent of the local chat and never contain a tools permission.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorCode, errorMessage, isRecord } from '../protocol/util.ts';
import type { Options } from '../host/config.ts';
import { sshConnector } from './ssh-link.ts';
import type { SshTarget } from './ssh-link.ts';

export interface ClientConfig {
  readonly machineId: string;
  readonly ssh?: SshTarget;
}

export const clientConfigPath = (env: NodeJS.ProcessEnv = process.env): string => resolve(env.PI_DURABLE_CLIENT_CONFIG
  ?? join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pi-durable', 'client.json'));

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

const validId = (id: unknown): id is string => typeof id === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

/** Checks a destination without starting SSH or reading credentials. */
export function validateTarget(target: SshTarget): SshTarget {
  sshConnector(target);
  return target;
}

/** Missing preferences are fine; malformed or unknown fields must not silently select another chat. */
export async function readClientConfig(env: NodeJS.ProcessEnv = process.env): Promise<ClientConfig | undefined> {
  const path = clientConfigPath(env);
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
  const invalid = (why: string): never => { throw new Error(`Invalid remote client configuration at ${path}: ${why}; fix it or use --local`); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid('it is not valid JSON'); }
  if (!isRecord(value)) return invalid('it must be an object like {"machineId":…,"ssh":{"host":…}}');
  if (!validId(value.machineId)) return invalid('machineId must be a UUID');
  const extra = Object.keys(value).find(key => !['machineId', 'ssh'].includes(key));
  if (extra !== undefined) return invalid(`unknown key ${extra}`);
  if (value.ssh === undefined) return { machineId: value.machineId };
  const ssh = value.ssh;
  if (!isRecord(ssh)) return invalid('ssh must be an object like {"host":…}');
  if (typeof ssh.host !== 'string') return invalid('ssh.host must be a string');
  for (const key of ['command', 'dataDir']) if (ssh[key] !== undefined && typeof ssh[key] !== 'string') return invalid(`ssh.${key} must be a string`);
  const unknown = Object.keys(ssh).find(key => !['host', 'command', 'dataDir'].includes(key));
  if (unknown !== undefined) return invalid(`unknown key ssh.${unknown} (ports, users and keys go in ~/.ssh/config)`);
  const target: SshTarget = { host: ssh.host, ...typeof ssh.command === 'string' ? { command: ssh.command } : {},
    ...typeof ssh.dataDir === 'string' ? { dataDir: ssh.dataDir } : {} };
  try { validateTarget(target); } catch (error) { return invalid(errorMessage(error)); }
  return { machineId: value.machineId, ssh: target };
}

/** Stable even for one-launch overrides, without turning the override into a default. */
export async function machineId(env: NodeJS.ProcessEnv = process.env, saved?: ClientConfig): Promise<string> {
  if (saved) return saved.machineId;
  const path = join(dirname(clientConfigPath(env)), 'machine-id');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID(), temp = `${path}.${id}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(`${id}\n`); await file.sync(); } finally { await file.close(); }
    // Publish an already complete file without overwriting another launch's identity.
    try { await link(temp, path); await syncDirectory(dirname(path)); return id; }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  } finally { await unlink(temp); }
  const existing = (await readFile(path, 'utf8')).trim();
  if (!validId(existing)) throw new Error(`Invalid machine ID at ${path}; fix it or use --local`);
  return existing;
}

/** Atomic private preferences write; does not touch the chat or its saved settings. */
export async function saveClientConfig(config: ClientConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!validId(config.machineId)) throw new Error('Invalid client machine ID');
  if (config.ssh) validateTarget(config.ssh);
  const path = clientConfigPath(env), temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(config, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally { await unlink(temp).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; }); }
}

/** --local bypasses even malformed saved preferences; explicit host, environment, then saved default. */
export async function remoteTarget(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<{ target: SshTarget; saved?: ClientConfig } | undefined> {
  if (options.local || options.command !== 'chat') return undefined;
  const saved = await readClientConfig(env), environmentHost = env.PI_DURABLE_REMOTE || undefined;
  const host = options.remote ?? environmentHost ?? saved?.ssh?.host;
  if (host === undefined) {
    if (options.remoteBin !== undefined || options.remoteDataDir !== undefined) throw new Error('--remote-bin and --remote-data-dir require --remote or a configured remote');
    return undefined;
  }
  const unsupported = options.remoteUnsupported ?? (options.prompt !== undefined ? 'a prompt' : undefined);
  if (unsupported) throw new Error(`${unsupported} is not supported for remote chat; use --local for the local chat`);
  const defaults = options.remote === undefined && environmentHost === undefined ? saved?.ssh : undefined;
  const command = options.remoteBin ?? defaults?.command, dataDir = options.remoteDataDir ?? defaults?.dataDir;
  return { target: validateTarget({ host, ...command !== undefined ? { command } : {}, ...dataDir !== undefined ? { dataDir } : {} }),
    ...saved ? { saved } : {} };
}
