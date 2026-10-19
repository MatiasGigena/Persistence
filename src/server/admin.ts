// The admin commands' side of the socket: `pi-durable backup`, `serve pair` and `serve devices [--revoke NAME]`
// send one `admin.*` request to the running server and print its answer. Kept apart from serve.ts so the CLI loads
// no runtime for them.
import { lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import type { Config } from '../host/config.ts';
import { errorCode, VERSION } from '../host/config.ts';
import type { ClientMessage, Device, Request, Response } from '../protocol/messages.ts';
import { isParseError, parseServerMessage } from '../protocol/parse.ts';
import { PROTOCOL } from '../protocol/version.ts';
import { lineSplitter } from './transport-unix.ts';

/** No server answers on the socket (none there, or a stale file): the caller may take the flock instead. */
export class NoServer extends Error {}

type Ok = Extract<Response, { ok: true }>;

/** How long an admin request may take; a backup of a large chat takes a while. */
const ADMIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Sends `request` (its `id` is 1) to the server on `path` and resolves with its successful `res`. Refuses a socket
 * not owned by this user. Rejects with NoServer when nothing listens there, and with the server's message when the
 * request fails.
 */
export async function adminRequest(path: string, request: Request, { timeoutMs = ADMIN_TIMEOUT_MS } = {}): Promise<Ok> {
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
    socket.on('data', lineSplitter(Number.MAX_SAFE_INTEGER, text => {
      const message = parseServerMessage(text);
      if (isParseError(message)) return;
      if (message.t === 'bye') finish(new Error(`The server ended the connection: ${message.reason}`));
      else if (message.t === 'res' && message.id === request.id) {
        if (message.ok) finish(undefined, message);
        else finish(new Error(message.error.message));
      }
    }, () => {}));
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
  const { code, expiresAt } = response.result;
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  console.log(`Pairing code: ${code}\nEnter it in the web app with a name for the device. Valid for ${minutes} minutes, once.`);
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

/** A size in bytes, readably. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit] ?? ''}`;
}
