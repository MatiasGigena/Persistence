// The client's side of a connection to `pi-durable serve` (docs/protocol.md): `ClientLink` says hello, waits for
// the welcome, pings, and reconnects with backoff until a `bye` or the user ends it. It reaches the server through a
// `Connector`; `unixConnector` is the Unix socket one (NDJSON), and tests plug in an in-memory one.
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { CloseCode } from '../protocol/messages.ts';
import type { Bye, ClientMessage, Op, RequestOf, ServerMessage, Welcome } from '../protocol/messages.ts';
import { isParseError, parseServerMessage } from '../protocol/parse.ts';
import { PROTOCOL } from '../protocol/version.ts';
import { errorMessage } from '../protocol/util.ts';

/** One connection's message channel, whatever carries it. */
export interface Channel {
  /** Sends one serialized message; dropped when the connection is gone. */
  send(text: string): void;
  /** Ends the connection; the connector's `end` follows. */
  close(): void;
}

/** What a connector reports about the connection it opened. */
export interface ChannelEvents {
  /** One incoming message, as text. */
  message(text: string): void;
  /** The connection is gone, closed by either side. Called once. */
  end(): void;
}

/** Opens one connection, or rejects: no server, refused, or (ForeignSocket) not the user's socket. */
export type Connector = (events: ChannelEvents) => Promise<Channel>;

/** The socket exists but belongs to someone else, or is not a socket: never connect to it. */
export class ForeignSocket extends Error {}

/** The file at `path` is a socket owned by this user; rejects with ForeignSocket otherwise (ENOENT as is). */
export async function checkSocket(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isSocket()) throw new ForeignSocket(`${path} is not a socket`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new ForeignSocket(`${path} belongs to uid ${info.uid}, not to you; refusing to connect`);
  }
}

/** How long `close()` waits for the server to end its side before the socket is destroyed. */
const END_GRACE_MS = 1000;

/** The Unix socket at `path`, as NDJSON: one message per line. Checks the socket's owner before every connect. */
export function unixConnector(path: string): Connector {
  return async events => {
    await checkSocket(path);
    const socket = createConnection({ path });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) events.message(line);
      }
    });
    // A reset or a write after the server left: 'close' follows, and that is the end.
    socket.on('error', () => undefined);
    socket.once('close', () => events.end());
    return {
      send: text => { if (socket.writable) socket.write(`${text}\n`); },
      close: () => {
        socket.end();
        setTimeout(() => socket.destroy(), END_GRACE_MS).unref();
      },
    };
  };
}

/**
 * The link's state: `connecting` until the first welcome, `open` while a connection is welcomed, `reconnecting`
 * while it retries after a drop, `closed` for good (a final `bye`, a foreign socket, or `close()`). A welcomed
 * connection's `bye` 1000 is final unless `reconnectNormal` is set; 4000 and 4001 are always final.
 */
export type LinkStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LinkOptions {
  readonly connect: Connector;
  /** `hello.client`: free text for the server's journal. */
  readonly client: string;
  readonly visible?: boolean;
  /** Reconnect after an established connection's normal bye (e.g. a sleeping laptop's silence timeout).
   * Default false. Explicit close(), version mismatch and unauthorized still stop for good. */
  readonly reconnectNormal?: boolean;
  /** A connection without a welcome this long after it opened is dropped. Default 1500 ms. */
  readonly helloMs?: number;
  /** A ping goes this often while open; nothing heard for twice this drops the connection. Default 20 s. */
  readonly pingMs?: number;
  /** Reconnect backoff: the first wait, doubled up to `max`, each ±20%. Default 250 ms to 5 s. */
  readonly retry?: { readonly first: number; readonly max: number };
  /** For the jitter; default Math.random. */
  readonly random?: () => number;
}

/** Codes of a `bye` after which the client does not reconnect. */
const FINAL: ReadonlySet<number> = new Set([CloseCode.normal, CloseCode.version, CloseCode.unauthorized]);

/** Why a connection attempt failed; `final` means do not retry. */
class Failed extends Error {
  readonly final: boolean;
  constructor(message: string, final: boolean, options?: ErrorOptions) { super(message, options); this.final = final; }
}

/** One connection attempt and, once welcomed, the live connection. */
interface Connection {
  channel?: Channel;
  welcomed: boolean;
  bye?: Bye;
  heard: number;
  readonly hello: PromiseWithResolvers<Welcome>;
}

const byeText = (bye: Bye): string => {
  if (bye.code === CloseCode.version) {
    return `The server refused this client's protocol (${PROTOCOL}): ${bye.reason || 'version mismatch'}. Update pi-durable.`;
  }
  if (bye.code === CloseCode.unauthorized) return `The server refused this client: ${bye.reason || 'unauthorized'}.`;
  return `The server closed the connection: ${bye.reason || `code ${bye.code}`}.`;
};

/** A message the client sends: one of the protocol's, or a request built for some op. */
export type Outgoing = ClientMessage | RequestOf<Op>;

/**
 * A reconnecting link to the server. `start()` makes the first connection (no retry: that is the probe); after it,
 * a dropped connection reconnects with backoff, and each new connection is welcomed again. Listeners get every
 * server message in order, each connection's `welcome` first.
 */
export class ClientLink {
  private readonly options: LinkOptions;
  private status: LinkStatus = 'connecting';
  private current: Connection | undefined;
  private reason: string | undefined;
  private wait: number;
  private pings = 0;
  private ticker: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly changeListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();

  constructor(options: LinkOptions) {
    this.options = options;
    this.wait = options.retry?.first ?? 250;
  }

  state(): LinkStatus { return this.status; }
  /** Why the link closed for good, readably; undefined while it is not closed, or after `close()`. */
  closedBecause(): string | undefined { return this.reason; }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** The first connection: resolves with its welcome, or rejects (and the link is closed). Call once. A socket that is not the user's rejects with ForeignSocket. */
  async start(): Promise<Welcome> {
    try { return await this.attempt(); } catch (error) {
      if (this.status !== 'closed') this.setStatus('closed');
      throw error;
    }
  }

  /** Sends on the open connection; false when there is none. */
  send(message: Outgoing): boolean {
    const channel = this.current?.welcomed ? this.current.channel : undefined;
    if (!channel || this.status !== 'open') return false;
    channel.send(JSON.stringify(message));
    return true;
  }

  /** Ends the link for good (detach): no reconnect. */
  close(): void {
    if (this.status === 'closed') return;
    clearTimeout(this.retryTimer);
    this.stopTicker();
    const connection = this.current;
    this.current = undefined;
    connection?.channel?.close();
    connection?.hello.reject(new Failed('Detached', true));
    this.setStatus('closed');
  }

  private setStatus(status: LinkStatus): void {
    this.status = status;
    for (const listener of [...this.changeListeners]) listener();
  }

  /** Connects, says hello, and resolves with the welcome within `helloMs`. */
  private async attempt(): Promise<Welcome> {
    const connection: Connection = { welcomed: false, heard: Date.now(), hello: Promise.withResolvers<Welcome>() };
    // A failed attempt that nobody awaits any more (closed meanwhile) must not surface as unhandled.
    connection.hello.promise.catch(() => undefined);
    this.current = connection;
    const events: ChannelEvents = {
      message: text => this.receive(connection, text),
      end: () => this.ended(connection),
    };
    let channel: Channel;
    try { channel = await this.options.connect(events); } catch (error) {
      if (this.current === connection) this.current = undefined;
      if (error instanceof ForeignSocket) throw error;
      throw new Failed(errorMessage(error), false, { cause: error });
    }
    if (this.current !== connection) {
      channel.close();
      throw new Failed('Detached', true);
    }
    connection.channel = channel;
    const timer = setTimeout(() => {
      connection.hello.reject(new Failed('The server did not answer hello in time', false));
      channel.close();
    }, this.options.helloMs ?? 1500);
    channel.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, client: this.options.client, visible: this.options.visible ?? true }));
    try { return await connection.hello.promise; } catch (error) {
      if (this.current === connection) this.current = undefined;
      throw error;
    } finally { clearTimeout(timer); }
  }

  private receive(connection: Connection, text: string): void {
    if (this.current !== connection) return;
    connection.heard = Date.now();
    const message = parseServerMessage(text);
    // Unknown types and malformed messages are ignored (docs/protocol.md, Versioning); a broken mirror resyncs.
    if (isParseError(message)) return;
    if (message.t === 'bye') connection.bye = message;
    if (!connection.welcomed) {
      if (message.t !== 'welcome') return;
      if (message.protocol !== PROTOCOL) {
        connection.hello.reject(new Failed(`The server speaks protocol ${message.protocol}, this client ${PROTOCOL}. Update pi-durable.`, true));
        connection.channel?.close();
        return;
      }
      connection.welcomed = true;
      this.wait = this.options.retry?.first ?? 250;
      this.startTicker(connection);
      this.setStatus('open');
      connection.hello.resolve(message);
    }
    for (const listener of [...this.messageListeners]) listener(message);
  }

  private ended(connection: Connection): void {
    if (this.current !== connection) return;
    if (!connection.welcomed) {
      const { bye } = connection;
      connection.hello.reject(bye ? new Failed(byeText(bye), FINAL.has(bye.code)) : new Failed('The server closed the connection', false));
      return;
    }
    this.current = undefined;
    this.stopTicker();
    const { bye } = connection;
    if (bye && FINAL.has(bye.code) && !(bye.code === CloseCode.normal && this.options.reconnectNormal)) {
      this.reason = byeText(bye);
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    this.schedule();
  }

  private schedule(): void {
    const { max } = this.options.retry ?? { max: 5000 };
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
    const delay = Math.round(this.wait * jitter);
    this.wait = Math.min(this.wait * 2, max);
    this.retryTimer = setTimeout(() => {
      this.attempt().catch((error: unknown) => {
        if (this.status === 'closed') return;
        if (error instanceof ForeignSocket || (error instanceof Failed && error.final)) {
          this.reason = error.message;
          this.setStatus('closed');
        } else this.schedule();
      });
    }, delay);
  }

  private startTicker(connection: Connection): void {
    const pingMs = this.options.pingMs ?? 20_000;
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (Date.now() - connection.heard > 2 * pingMs) { connection.channel?.close(); return; }
      connection.channel?.send(JSON.stringify({ t: 'ping', n: this.pings++ }));
    }, pingMs);
    this.ticker.unref();
  }

  private stopTicker(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
