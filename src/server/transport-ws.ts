// The web listener (docs/protocol.md "Web peers"): HTTP on 127.0.0.1 only, behind `tailscale serve`. It serves
// the app, `/api/me`, `/api/pair`, and upgrades `/ws` to a WebSocket that it hands to the hub as a PeerLink.
import { once } from 'node:events';
import { createServer, STATUS_CODES } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { ServeSettings } from '../host/config.ts';
import { errorMessage, isRecord } from '../protocol/util.ts';
import { cutBytes } from '../memory/util.ts';
import { CloseCode, ErrorCode, LIMITS } from '../protocol/messages.ts';
import type { Bye, Device, ErrorResponse } from '../protocol/messages.ts';
import { authenticate, gate, setCookie } from './auth.ts';
import type { Access, Devices, Refusal } from './auth.ts';
import type { PeerHub, PeerLink } from './link.ts';
import { createStaticFiles, DEFAULT_ROOTS, securityHeaders } from './static.ts';
import type { StaticFiles, StaticRoots } from './static.ts';

/** The only address the web listener binds. */
export const HOST = '127.0.0.1';
/**
 * Largest WebSocket frame, in bytes: LIMITS.clientMessage code units take at most 3 UTF-8 bytes each. A longer
 * frame closes the socket with 1009; a frame within it but over LIMITS.clientMessage code units gets
 * `bad_request` and the connection stays.
 */
export const MAX_PAYLOAD = 3 * LIMITS.clientMessage;
/** `/api/pair` attempts per client address and window. */
export const PAIR_RATE = { tries: 10, windowMs: 60_000 } as const;
const PAIR_BODY_MAX = 1024;
/** How long shutdown waits for clients to answer the close frame before cutting them off. */
const CLOSE_GRACE_MS = 1000;

export interface WebListener {
  /** The bound port (the setting, or the one the OS chose for port 0). */
  readonly port: number;
  /** Closes every WebSocket (1012, after `bye`) and stops listening. */
  close(): Promise<void>;
}

export interface WebListenerOptions {
  /** Where the app's files are; tests point it at fixtures. */
  readonly roots?: StaticRoots;
  /** One line for the server's log (the journal): pairings and errors. Default: stderr. */
  readonly log?: (line: string) => void;
}

const rawText = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8');

/** A WebSocket as a PeerLink. Messages that arrive before the hub listens are kept for it. */
function webLink(ws: WebSocket, login: string, device: Device): PeerLink {
  let deliver: ((text: string) => void) | undefined;
  let closed: (() => void) | undefined;
  const early: string[] = [];
  let gone = false;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { ws.close(1003, 'binary frames are not part of the protocol'); return; }
    const text = rawText(data);
    if (text.length > LIMITS.clientMessage) {
      const answer: ErrorResponse = { t: 'res', id: -1, ok: false, error: { code: ErrorCode.badRequest, message: `A message may be at most ${LIMITS.clientMessage} characters.` } };
      ws.send(JSON.stringify(answer));
      return;
    }
    if (deliver) deliver(text);
    else early.push(text);
  });
  ws.on('close', () => {
    gone = true;
    closed?.();
  });
  return {
    peer: 'web',
    who: `${login}/${device.name}`,
    device,
    send: text => { if (ws.readyState === WebSocket.OPEN) ws.send(text); },
    buffered: () => ws.bufferedAmount,
    close(code, reason) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bye: Bye = { t: 'bye', code, reason };
      ws.send(JSON.stringify(bye));
      // A close frame's reason is at most 123 bytes; `bye` carries the whole one.
      ws.close(code, cutBytes(reason, 123));
    },
    onMessage(listener) {
      deliver = listener;
      for (const text of early.splice(0)) listener(text);
    },
    onClose(listener) {
      if (gone) queueMicrotask(listener);
      else closed = listener;
    },
  };
}

/** The client's address for rate limits: the last X-Forwarded-For hop (tailscale serve's), else the socket's. */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const last = (typeof forwarded === 'string' ? forwarded : '').split(',').at(-1)?.trim();
  return last || request.socket.remoteAddress || 'unknown';
}

/** At most `tries` calls per key in any `windowMs`. */
function rateLimiter(tries: number, windowMs: number): (key: string) => boolean {
  const seen = new Map<string, number[]>();
  return key => {
    const now = Date.now();
    for (const [k, times] of seen) if (times.every(at => now - at >= windowMs)) seen.delete(k);
    const times = (seen.get(key) ?? []).filter(at => now - at < windowMs);
    if (times.length >= tries) return false;
    seen.set(key, [...times, now]);
    return true;
  };
}

async function readBody(request: IncomingMessage, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Refuses an upgrade on the raw socket, before any WebSocket handshake. */
function refuseUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * Starts the web listener on 127.0.0.1:`settings.port`, for `hub`, checking requests against `settings.origin`,
 * `settings.allowLogins` and `devices`. Rejects when either setting is missing (the server is then socket only)
 * or the port is taken.
 */
export async function startWebListener(hub: PeerHub, settings: ServeSettings, devices: Devices, options: WebListenerOptions = {}): Promise<WebListener> {
  const { origin, allowLogins } = settings;
  if (origin === undefined || allowLogins.length === 0) throw new Error('the web listener needs PI_DURABLE_ORIGIN and PI_DURABLE_ALLOW_LOGIN');
  const access: Access = { origin, allowLogins };
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const files: StaticFiles = await createStaticFiles(origin, options.roots ?? DEFAULT_ROOTS);
  const pairAllowed = rateLimiter(PAIR_RATE.tries, PAIR_RATE.windowMs);
  const links = new Map<WebSocket, PeerLink>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
    const body = value === undefined ? '' : JSON.stringify(value);
    response.writeHead(status, {
      ...securityHeaders(files.csp()), 'Cache-Control': 'no-store', ...headers,
      ...body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {},
    }).end(body);
  };
  const refuse = (response: ServerResponse, refusal: Refusal): void => json(response, refusal.status, { error: refusal.reason });

  async function pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') return json(response, 405, { error: 'method' }, { Allow: 'POST' });
    if (!pairAllowed(clientKey(request))) return json(response, 429, { error: 'too many tries' }, { 'Retry-After': String(PAIR_RATE.windowMs / 1000) });
    const body = await readBody(request, PAIR_BODY_MAX);
    let value: unknown;
    try { value = JSON.parse(body ?? ''); } catch { value = undefined; }
    if (!isRecord(value)) return json(response, 400, { error: 'malformed' });
    const paired = devices.redeem(value.code, value.name);
    if ('error' in paired) {
      return json(response, paired.error === 'malformed' ? 400 : paired.error === 'wrong' ? 401 : 409, { error: paired.error });
    }
    log(`web: paired device "${paired.device.name}"`);
    json(response, 204, undefined, { 'Set-Cookie': setCookie(paired.cookie) });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    const passed = gate(request, access);
    if (!passed.ok) return refuse(response, passed);
    if (pathname === '/api/pair') return pair(request, response);
    if (pathname === '/api/me') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method' }, { Allow: 'GET' });
      const me = authenticate(request, access, devices);
      return me.ok ? json(response, 200, { device: me.device.name }) : refuse(response, me);
    }
    if (pathname === '/ws') return json(response, 426, { error: 'upgrade' }, { Upgrade: 'websocket' });
    if (pathname.startsWith('/api/')) return json(response, 404, { error: 'not found' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method' }, { Allow: 'GET, HEAD' });
    await files.serve(request, response, pathname);
  }

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    if ((request.url ?? '').split('?', 1)[0] !== '/ws') return refuseUpgrade(socket, 404, 'not found');
    const me = authenticate(request, access, devices);
    if (!me.ok) return refuseUpgrade(socket, me.status, me.reason);
    wss.handleUpgrade(request, socket, head, ws => {
      // ws reports protocol errors (an oversized frame: 1009) here and then closes; nothing else to do.
      ws.on('error', () => undefined);
      const link = webLink(ws, me.login, me.device);
      links.set(ws, link);
      ws.on('close', () => links.delete(ws));
      hub.attach(link);
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(`web: ${request.method ?? '?'} ${request.url ?? '?'} failed: ${errorMessage(error)}`);
      if (!response.headersSent) json(response, 500, { error: 'internal' });
      else response.destroy();
    });
  });
  server.on('upgrade', upgrade);
  await new Promise<void>((resolve, reject) => {
    const failed = (error: unknown): void => reject(new Error(`cannot listen on ${HOST}:${settings.port}: ${errorMessage(error)}`));
    server.once('error', failed);
    server.listen(settings.port, HOST, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : settings.port;

  return {
    port,
    async close() {
      const open = [...links.keys()];
      for (const link of links.values()) link.close(CloseCode.restart, 'The server is stopping.');
      const closing = Promise.all(open.map(ws => ws.readyState === WebSocket.CLOSED ? undefined : once(ws, 'close')));
      await Promise.race([closing, delay(CLOSE_GRACE_MS, undefined, { ref: false })]);
      for (const ws of open) ws.terminate();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      wss.close();
      await stopped;
    },
  };
}
