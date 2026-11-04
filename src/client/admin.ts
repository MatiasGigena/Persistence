// The admin commands' side of the socket: `pi-durable backup`, `serve pair`, `serve devices [--revoke NAME]` and
// `serve agents [--archive NAME | --archive-adhoc | --restore NAME]` send one request to the running server and print its answer. Kept apart from serve.ts so the CLI loads
// no runtime for them.
import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import type { Config } from '../config/options.ts';
import { VERSION } from '../config/options.ts';
import { errorCode } from '../protocol/util.ts';
import { ARCHIVE_TTL_MS } from '../protocol/messages.ts';
import type { ClientMessage, Device, Request, Response, ServerMessage } from '../protocol/messages.ts';
import type { AgentStatus } from '../protocol/session.ts';
import { isParseError, parseServerMessage } from '../protocol/parse.ts';
import { PROTOCOL } from '../protocol/version.ts';
import { lineSplitter } from '../protocol/lines.ts';
import { RequestError } from '../protocol/request-error.ts';

/** No server answers on the socket (none there, or a stale file): the caller may take the flock instead. */
export class NoServer extends Error {}

type Ok = Extract<Response, { ok: true }>;

export interface AdminRequestOptions {
  readonly timeoutMs?: number;
  /** Sees every server message, before the answer settles the request. */
  readonly onMessage?: (message: ServerMessage) => void;
}

/** How long an admin request may take; a backup of a large chat takes a while. */
const ADMIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Sends `request` (its `id` is 1) to the server on `path` and resolves with its successful `res`. Refuses a socket
 * not owned by this user. Rejects with NoServer when nothing listens there, and with a RequestError (the server's code
 * and message) when the request fails.
 */
export async function adminRequest(path: string, request: Request, { timeoutMs = ADMIN_TIMEOUT_MS, onMessage }: AdminRequestOptions = {}): Promise<Ok> {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new NoServer(`${path} is not a socket`);
    if (info.uid !== process.getuid?.()) throw new Error(`${path} belongs to another user; refusing to connect`);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new NoServer('No server is running for this chat.');
    throw error;
  }
  return new Promise<Ok>((resolve, reject) => {
    const socket = connect(path);
    const send = (message: ClientMessage): void => { socket.write(`${JSON.stringify(message)}\n`); };
    let settled = false;
    const finish = (error: Error | undefined, response?: Ok): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (response) resolve(response);
      else reject(error ?? new Error('The server closed the connection.'));
    };
    const timer = setTimeout(() => finish(new Error('The server did not answer in time.')), timeoutMs);
    socket.once('connect', () => {
      send({ t: 'hello', protocol: PROTOCOL, client: `pi-durable-admin ${VERSION}`, visible: false });
      send(request);
    });
    socket.on('error', error => {
      const code = errorCode(error);
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? new NoServer('No server is running for this chat.') : error);
    });
    socket.on('close', () => finish(undefined));
    socket.setEncoding('utf8');
    socket.on('data', lineSplitter(Number.MAX_SAFE_INTEGER, text => {
      const message = parseServerMessage(text);
      if (isParseError(message)) return;
      onMessage?.(message);
      if (message.t === 'bye') finish(new Error(`The server ended the connection: ${message.reason}`));
      else if (message.t === 'res' && message.id === request.id) {
        if (message.ok) finish(undefined, message);
        else finish(new RequestError(message.error.code, message.error.message));
      }
    }));
  });
}

const socketOf = (config: Pick<Config, 'socketPath'>): string => {
  if (!config.socketPath) throw new NoServer('This chat has no server socket (its path is too long, and XDG_RUNTIME_DIR is unset).');
  return config.socketPath;
};

/** `pi-durable backup` through the running server; rejects with NoServer when there is none. */
export async function backupOverSocket(config: Pick<Config, 'socketPath' | 'out'>): Promise<{ path: string; bytes: number }> {
  // The server wants an absolute path: --out is relative to where the command runs.
  const params = config.out === undefined ? {} : { out: resolve(config.out) };
  const response = await adminRequest(socketOf(config), { t: 'req', id: 1, op: 'admin.backup', params });
  if (response.op !== 'admin.backup') throw new Error('The server answered another request.');
  return { ...response.result };
}

const serverNeeded = (error: unknown): never => {
  if (error instanceof NoServer) throw new Error(`${error.message} Start it with pi-durable serve (or systemctl --user start pi-durable).`);
  throw error;
};

const when = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `pi-durable serve pair`: prints a one-time pairing code. */
export async function pairCommand(config: Pick<Config, 'socketPath'>): Promise<void> {
  const response = await adminRequest(socketOf(config), { t: 'req', id: 1, op: 'admin.pair', params: {} }).catch(serverNeeded);
  if (response.op !== 'admin.pair') throw new Error('The server answered another request.');
  const { code, expiresAt, origin } = response.result;
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  const where = origin === undefined ? 'in the web app' : `in the web app at ${origin}`;
  console.log(`Pairing code: ${code}\nEnter it ${where} with a name for the device. Valid for ${minutes} minutes, once.`);
}

/** `pi-durable serve devices [--revoke NAME]`: lists the paired devices, or revokes one. */
export async function devicesCommand(config: Pick<Config, 'socketPath' | 'revoke'>): Promise<void> {
  const path = socketOf(config);
  if (config.revoke !== undefined) {
    await adminRequest(path, { t: 'req', id: 1, op: 'admin.revoke', params: { name: config.revoke } }).catch(serverNeeded);
    console.log(`Revoked ${config.revoke}; its connections are closed.`);
    return;
  }
  const response = await adminRequest(path, { t: 'req', id: 1, op: 'admin.devices', params: {} }).catch(serverNeeded);
  if (response.op !== 'admin.devices') throw new Error('The server answered another request.');
  const devices: readonly Device[] = response.result.devices;
  if (!devices.length) { console.log('No paired devices. Pair one with pi-durable serve pair.'); return; }
  for (const device of devices) {
    console.log(`${device.name}  paired ${when(device.pairedAt)}${device.lastSeen === undefined ? '' : `  last seen ${when(device.lastSeen)}`}`);
  }
}

/**
 * The agents the server reports in its first `status` (archived ones included), from a connection on `path`. The
 * status comes before `ready`, so `ready` without one means no agents.
 */
async function agentsOverSocket(path: string): Promise<readonly AgentStatus[]> {
  // A cheap op to wait on: the status and `ready` both come before its answer.
  let agents: readonly AgentStatus[] = [];
  await adminRequest(path, { t: 'req', id: 1, op: 'thinking.levels', params: {} }, {
    onMessage: (message: ServerMessage) => { if (message.t === 'status') agents = message.status.agents; },
  });
  return agents;
}

/** A local time, readably: `2026-10-22 14:05`. */
const localTime = (ms: number): string => {
  const date = new Date(ms), two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** One agent's line for `serve agents`. */
export function agentLine(agent: AgentStatus, ttlMs: number): string {
  const state = agent.archivedAt === undefined ? agent.busy ? 'busy' : 'idle'
    : `archived, deleted at ${localTime(agent.archivedAt + ttlMs)}`;
  return `${agent.name}  ${agent.role}${agent.role === 'sub' ? ` of ${agent.parent}` : ''}  ${state}`;
}

/** `pi-durable serve agents [--archive NAME | --archive-adhoc | --restore NAME]`: lists the agents, or changes one. */
export async function agentsCommand(config: Pick<Config, 'socketPath' | 'archive' | 'archiveAdhoc' | 'restore'>): Promise<void> {
  const path = socketOf(config);
  if (config.restore !== undefined) {
    const response = await adminRequest(path, { t: 'req', id: 1, op: 'agents.restore', params: { name: config.restore } }).catch(serverNeeded);
    if (response.op !== 'agents.restore') throw new Error('The server answered another request.');
    console.log(`Restored ${response.result.names.join(', ')}.`);
    return;
  }
  if (config.archive !== undefined || config.archiveAdhoc) {
    const params = config.archive === undefined ? { adhoc: true } as const : { name: config.archive };
    const response = await adminRequest(path, { t: 'req', id: 1, op: 'agents.archive', params }).catch(serverNeeded);
    if (response.op !== 'agents.archive') throw new Error('The server answered another request.');
    const { names } = response.result;
    console.log(names.length ? `Archived ${names.join(', ')}; deleted in a day unless restored (--restore NAME).` : 'No ad-hoc agents to archive.');
    return;
  }
  const agents = await agentsOverSocket(path).catch(serverNeeded);
  if (!agents.length) { console.log('No agents.'); return; }
  const active = agents.filter(agent => agent.archivedAt === undefined), archived = agents.filter(agent => agent.archivedAt !== undefined);
  for (const agent of [...active, ...archived]) console.log(agentLine(agent, ARCHIVE_TTL_MS));
}

/** A size in bytes, readably. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit] ?? ''}`;
}
