// Where a chat's files are and what `serve` reads from its environment: one module, so the CLI, the host, the server,
// the attaching clients and the backup agree on every path. No CLI parsing here (src/config/options.ts).
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { errorCode } from '../protocol/util.ts';

export const DEFAULT_PORT = 7433;

/** What `serve` reads from its environment (and --port); see HELP. */
export interface ServeSettings {
  /** Loopback TCP port of the web listener. */
  readonly port: number;
  /** PI_DURABLE_ORIGIN, normalized; the web listener runs only with it and `allowLogins`. */
  readonly origin?: string;
  /** PI_DURABLE_ALLOW_LOGIN: Tailscale logins (`Tailscale-User-Login`) let in. Empty: no web listener. */
  readonly allowLogins: readonly string[];
  /** PI_DURABLE_REMOTE_TOOLS. */
  readonly remoteTools: 'confirm' | 'off';
  /** PI_DURABLE_TOOLS_IDLE_MIN: the tools turn off after this many minutes without a run; undefined: never (the default). */
  readonly toolsIdleMinutes?: number;
  /** PI_DURABLE_PUSH_PREVIEW: push notifications carry the reply's first words. */
  readonly pushPreview: boolean;
}

/** The files a chat keeps beside its database (`statePaths`). Only the host or server under the flock writes them. */
export interface StatePaths {
  /** The flock target: `<db>.lock`. */
  readonly lock: string;
  /** The UniiChat memory: `chat.sqlite` → `chat.unii`. */
  readonly memoryDir: string;
  readonly settings: string;
  /**
   * The server's Unix socket (mode 600): `<db>.sock`, or, when that is over 107 bytes (the sun_path limit),
   * `$XDG_RUNTIME_DIR/pi-durable-<hash>.sock`; undefined when it is too long and XDG_RUNTIME_DIR is unset.
   */
  readonly socket: string | undefined;
  /** The server's state directory (mode 700): `serve/` beside the database. */
  readonly serveDir: string;
  /** VAPID key pair for Web Push. */
  readonly vapid: string;
  /** Web Push subscriptions. */
  readonly push: string;
  /** Paired web devices: names and sha256 of their cookies. */
  readonly devices: string;
}

/** Longest Unix socket path: sun_path is 108 bytes on Linux, its NUL included. */
export const SOCKET_PATH_MAX = 107;

/**
 * Every file a chat keeps beside its database `databasePath` (resolved, symlinks included). One function, so the
 * host, the server, the attaching client and the backup agree. Reads `XDG_RUNTIME_DIR` from `env` for the socket.
 */
export function statePaths(databasePath: string, env: NodeJS.ProcessEnv = process.env): StatePaths {
  const dir = dirname(databasePath), serveDir = join(dir, 'serve');
  let socket: string | undefined = `${databasePath}.sock`;
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    // XDG_RUNTIME_DIR is the user's own (mode 700), so no one else can squat the name; /tmp would not be.
    const hash = createHash('sha256').update(databasePath).digest('hex').slice(0, 16);
    socket = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, `pi-durable-${hash}.sock`) : undefined;
    if (socket && Buffer.byteLength(socket) > SOCKET_PATH_MAX) socket = undefined;
  }
  return {
    lock: `${databasePath}.lock`,
    // The chat's memory (log, tree, view) lives beside its database, under its flock.
    memoryDir: databasePath.replace(/(\.sqlite)?$/, '.unii'),
    // Beside the database, under its flock; read here, written only by a work launch's /model.
    settings: join(dir, 'settings.json'),
    socket,
    serveDir,
    vapid: join(serveDir, 'vapid.json'),
    push: join(serveDir, 'push.json'),
    devices: join(serveDir, 'devices.json'),
  };
}

/** The data directory: --data-dir, else PI_DURABLE_DATA_DIR, else `$XDG_STATE_HOME/pi-durable` (~/.local/state). */
export function dataDirOf(dataDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dataDir ?? env.PI_DURABLE_DATA_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-durable'));
}

/** A TCP port, 1 to 65535; `what` names the source in the error. */
export function parsePort(spec: string, what: string): number {
  const port = /^\d{1,5}$/.test(spec) ? Number(spec) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`${what} must be a port number from 1 to 65535`);
  return port;
}

/** PI_DURABLE_CHROMIUM: unset or empty for Playwright's own Chromium, else an absolute path; rejects anything else. */
export function chromiumPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.PI_DURABLE_CHROMIUM;
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new Error('PI_DURABLE_CHROMIUM must be an absolute path to the Chromium executable');
  return resolve(value);
}

/** `serve`'s settings from --port and the environment; rejects a malformed variable by name. */
export function serveSettings(options: { readonly port?: number | undefined }, env: NodeJS.ProcessEnv = process.env): ServeSettings {
  const port = options.port ?? (env.PI_DURABLE_PORT ? parsePort(env.PI_DURABLE_PORT, 'PI_DURABLE_PORT') : DEFAULT_PORT);
  const allowLogins = (env.PI_DURABLE_ALLOW_LOGIN ?? '').split(',').map(login => login.trim()).filter(Boolean);
  if (env.PI_DURABLE_ALLOW_LOGIN?.trim() && allowLogins.some(login => /\s/.test(login))) {
    throw new Error('PI_DURABLE_ALLOW_LOGIN must be Tailscale logins separated by commas');
  }
  const remoteTools = env.PI_DURABLE_REMOTE_TOOLS || 'confirm';
  if (remoteTools !== 'confirm' && remoteTools !== 'off') throw new Error('PI_DURABLE_REMOTE_TOOLS must be confirm or off');
  const idle = env.PI_DURABLE_TOOLS_IDLE_MIN || 'off';
  const toolsIdleMinutes = idle === 'off' ? undefined : /^\d{1,4}$/.test(idle) ? Number(idle) : NaN;
  if (toolsIdleMinutes !== undefined && !(toolsIdleMinutes >= 1 && toolsIdleMinutes <= 1440)) {
    throw new Error('PI_DURABLE_TOOLS_IDLE_MIN must be off or minutes from 1 to 1440');
  }
  const preview = env.PI_DURABLE_PUSH_PREVIEW || 'off';
  if (preview !== 'on' && preview !== 'off') throw new Error('PI_DURABLE_PUSH_PREVIEW must be on or off');
  const settings: ServeSettings = { port, allowLogins, remoteTools, ...toolsIdleMinutes === undefined ? {} : { toolsIdleMinutes }, pushPreview: preview === 'on' };
  return env.PI_DURABLE_ORIGIN ? { ...settings, origin: parseOrigin(env.PI_DURABLE_ORIGIN) } : settings;
}

/** An origin (scheme, host, port; no path): https, or http on a loopback host for development. */
function parseOrigin(value: string): string {
  const problem = 'PI_DURABLE_ORIGIN must be an origin like https://host.tailnet.ts.net (no path)';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(problem); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value.replace(/\/$/, '') || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error(problem);
  }
  return url.origin;
}

/** The bridge only locates the existing socket: no directories, model settings or credentials are loaded. */
export async function resolveSocketPath(options: { readonly database?: string | undefined; readonly dataDir?: string | undefined },
  env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dataDir = dataDirOf(options.dataDir, env);
  let databasePath = resolve(options.database ?? join(dataDir, 'chat.sqlite'));
  try { databasePath = await realpath(databasePath); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const socket = statePaths(databasePath, env).socket;
  if (socket === undefined) throw new Error('This chat has no server socket: its path is too long and XDG_RUNTIME_DIR is unset');
  return socket;
}
