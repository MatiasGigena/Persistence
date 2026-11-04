// One peer of the server (docs/protocol.md): its handshake, its requests, and the state it was sent. Feeds and the
// status are synced, not queued: each flush diffs what the peer has against the current state, so a slow peer gets
// the latest state rather than every step. Events (`res`, `notice`, `pong`, `feed.end`) are written as they come.
import { CloseCode, ErrorCode, LIMITS, ROOT_FEED, SOCKET_ONLY, WEB_ONLY } from '../protocol/messages.ts';
import type {
  ChatItem, ClientMessage, ErrorCode as ErrorCodeType, NoticeLevel, Op, Params, RequestOf, ResponseOf, Result,
  ServerMessage, SessionStatus, Welcome,
} from '../protocol/messages.ts';
import { diffItems, wireItem } from '../protocol/diff.ts';
import { isParseError, parseClientMessage } from '../protocol/parse.ts';
import { PROTOCOL } from '../protocol/version.ts';
import type { MachineCall, MachineCancel, MachineResult } from '../protocol/machines.ts';
import type { ChatFeed } from '../ui/types.ts';
import type { PeerLink } from './link.ts';
import { errorMessage } from '../protocol/util.ts';
import { NotFound, Unavailable } from '../ui/errors.ts';

/** Status messages to one peer at most this often (4 a second): it changes with every streamed token. */
export const STATUS_MS = 250;
/** A peer that sends nothing this long is closed; clients ping every LIMITS.pingMs. */
export const SILENCE_MS = 60_000;
/** Requests one peer may have unanswered at once; more are refused with `unavailable`. */
export const MAX_IN_FLIGHT = 32;
/** How often each connection checks for silence and a stuck send buffer. */
const TICK_MS = 1_000;

/** A request's failure, as its `res` carries it. */
export class OpError extends Error {
  readonly code: ErrorCodeType;
  constructor(code: ErrorCodeType, message: string) {
    super(message);
    this.code = code;
  }
}

/** The wire code for a handler's failure: an OpError's own, the session's typed refusals, else `failed`. */
function codeOf(error: unknown): ErrorCodeType {
  if (error instanceof OpError) return error.code;
  if (error instanceof NotFound) return ErrorCode.notFound;
  if (error instanceof Unavailable) return ErrorCode.unavailable;
  return ErrorCode.failed;
}

/** Every op's handler: params already parsed, the result as the op's `res` carries it. */
export type Handlers = { readonly [O in Op]: (params: Params<O>, connection: Connection) => Promise<Result<O>> };

/** What a connection needs from its hub. */
export interface ConnectionHost {
  readonly handlers: Handlers;
  /** The `welcome` for this link (everything but `t`). */
  welcome(link: PeerLink): Omit<Welcome, 't'>;
  /** The session's current status, once it is up. */
  status(): SessionStatus | undefined;
  /** Pi's feed, once the session is up. */
  root(): ChatFeed | undefined;
  /** A visibility change, or the end of a visible connection. */
  visibility(connection: Connection): void;
  /** The connection ended: release what it held. Called once. */
  closed(connection: Connection): void;
  machineResult?(connection: Connection, message: MachineResult): void;
}

type Outgoing = ServerMessage | ResponseOf<Op>;

interface FeedSync {
  readonly feed: ChatFeed;
  /** The wire items last sent; undefined until a snapshot goes. */
  sent: readonly ChatItem[] | undefined;
  dirty: boolean;
}

/** One peer: from `hello` to `bye`. Created by the hub for each link it is given. */
export class Connection {
  readonly link: PeerLink;
  private readonly host: ConnectionHost;
  private phase: 'hello' | 'welcomed' | 'ready' | 'closed' = 'hello';
  private shown = false;
  private readonly feeds = new Map<string, FeedSync>();
  private statusSent: string | undefined;
  private statusAt = -Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  private readonly ticker: ReturnType<typeof setInterval>;
  private heardAt = Date.now();
  private slowSince: number | undefined;
  private inFlight = 0;
  /** When this peer last could be seen: now while `visible`. */
  visibleAt = -Infinity;

  constructor(link: PeerLink, host: ConnectionHost) {
    this.link = link;
    this.host = host;
    this.helloTimer = setTimeout(() => this.close(CloseCode.version, 'No hello'), LIMITS.helloMs);
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    link.onMessage(text => this.receive(text));
    link.onClose(() => this.ended());
  }

  /** The user can see this client now (its last `hello` or `visible`). */
  get visible(): boolean { return this.shown && this.phase !== 'closed'; }
  get isClosed(): boolean { return this.phase === 'closed'; }
  /** Past `hello`: requests are served. */
  get welcomed(): boolean { return this.phase === 'welcomed' || this.phase === 'ready'; }

  /** Ends the connection: `bye` (sent by the link), then the transport closes. */
  close(code: CloseCode, reason: string): void {
    if (this.phase === 'closed') return;
    this.link.close(code, reason);
    this.ended();
  }

  /** The session is up: the initial state, then `ready`. Called by the hub for welcomed connections. */
  start(): void {
    const status = this.host.status(), root = this.host.root();
    if (this.phase !== 'welcomed' || !status || !root) return;
    this.phase = 'ready';
    this.sendStatus(status);
    this.feeds.set(ROOT_FEED, { feed: root, sent: undefined, dirty: true });
    this.flushFeed(ROOT_FEED);
    this.send({ t: 'ready' });
  }

  /** Sends a notice now (an event: never coalesced). */
  notice(text: string, level: NoticeLevel): void {
    if (this.phase === 'ready') this.send({ t: 'notice', text, level });
  }

  /** The status changed: a `status` goes within STATUS_MS. */
  statusChanged(): void {
    if (this.phase !== 'ready' || this.statusTimer) return;
    const wait = Math.max(LIMITS.flushMs, this.statusAt + STATUS_MS - Date.now());
    this.statusTimer = setTimeout(() => { this.statusTimer = undefined; this.flushStatus(); }, wait);
  }

  /** A feed this peer holds changed: a diff goes within LIMITS.flushMs. */
  feedChanged(id: string): void {
    const sync = this.feeds.get(id);
    if (!sync) return;
    sync.dirty = true;
    this.schedule();
  }

  /** Starts syncing an agent feed; its snapshot follows within LIMITS.flushMs (after the `res` of feed.open). */
  addFeed(id: string, feed: ChatFeed): void {
    const sync = this.feeds.get(id);
    if (sync) sync.sent = undefined;
    else this.feeds.set(id, { feed, sent: undefined, dirty: true });
    this.feedChanged(id);
  }

  hasFeed(id: string): boolean { return this.feeds.has(id); }

  /** Stops syncing a feed; with `reason`, tells the peer with `feed.end`. */
  removeFeed(id: string, reason?: string): void {
    if (!this.feeds.delete(id)) return;
    if (reason !== undefined && this.phase === 'ready') this.send({ t: 'feed.end', feed: id, reason });
  }

  /** The next flush sends a whole snapshot of the feed. */
  resync(id: string): void {
    const sync = this.feeds.get(id);
    if (!sync) return;
    sync.sent = undefined;
    this.feedChanged(id);
  }

  /** Tool execution events are sent only after this authenticated connection is ready. */
  sendMachine(message: MachineCall | MachineCancel): void {
    if (this.phase === 'ready') this.send(message);
  }

  private send(message: Outgoing): void {
    if (this.phase === 'closed') return;
    this.link.send(JSON.stringify(message));
  }

  private fail(id: number, code: ErrorCodeType, message: string): void {
    this.send({ t: 'res', id, ok: false, error: { code, message } });
  }

  private receive(text: string): void {
    if (this.phase === 'closed') return;
    this.heardAt = Date.now();
    const message = parseClientMessage(text);
    if (isParseError(message)) {
      if (message.invalid === 'unknown_type') return;
      if (message.id === undefined) { this.fail(-1, ErrorCode.badRequest, message.message); return; }
      if (this.phase === 'hello') { this.fail(message.id, ErrorCode.version, 'Send hello first.'); return; }
      this.fail(message.id, message.invalid === 'unknown_op' ? ErrorCode.unknownOp : ErrorCode.badRequest, message.message);
      return;
    }
    this.handle(message);
  }

  private handle(message: ClientMessage): void {
    switch (message.t) {
      case 'hello': {
        if (this.phase !== 'hello') return;
        clearTimeout(this.helloTimer);
        if (message.protocol !== PROTOCOL) {
          this.close(CloseCode.version, `This server speaks protocol ${PROTOCOL}, not ${message.protocol}.`);
          return;
        }
        this.phase = 'welcomed';
        this.setVisible(message.visible);
        this.send({ t: 'welcome', ...this.host.welcome(this.link) });
        this.start();
        return;
      }
      case 'visible':
        if (this.phase !== 'hello') this.setVisible(message.visible);
        return;
      case 'ping':
        if (this.phase !== 'hello') this.send({ t: 'pong', n: message.n });
        return;
      case 'machine.result':
        if (this.phase === 'ready' && this.link.peer === 'socket') this.host.machineResult?.(this, message);
        return;
      case 'req':
        if (this.phase === 'hello') { this.fail(message.id, ErrorCode.version, 'Send hello first.'); return; }
        if ((this.link.peer === 'web' ? SOCKET_ONLY : WEB_ONLY).has(message.op)) {
          this.fail(message.id, ErrorCode.forbidden, `${message.op} is only for ${this.link.peer === 'web' ? 'a terminal on the server' : 'the web app'}.`);
          return;
        }
        if (this.inFlight >= MAX_IN_FLIGHT) {
          this.fail(message.id, ErrorCode.unavailable, `Too many requests at once (at most ${MAX_IN_FLIGHT}).`);
          return;
        }
        void this.request(message);
    }
  }

  private async request<O extends Op>(request: RequestOf<O>): Promise<void> {
    this.inFlight++;
    try {
      const handler = this.host.handlers[request.op];
      const result = await handler(request.params, this);
      // A feed.open's snapshot is sent by a later timer, so this `res` precedes it.
      const response: ResponseOf<O> = { t: 'res', id: request.id, op: request.op, ok: true, result };
      this.send(response);
    } catch (error) {
      this.fail(request.id, codeOf(error), errorMessage(error));
    } finally {
      this.inFlight--;
    }
  }

  private setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.visibleAt = Date.now();
    this.host.visibility(this);
  }

  private schedule(): void {
    if (this.flushTimer || this.phase !== 'ready') return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, LIMITS.flushMs);
  }

  /** Over the high water mark the flush waits a tick: the next diff covers whatever changed meanwhile. */
  private congested(): boolean {
    if (this.link.buffered() <= LIMITS.highWater) return false;
    this.watchSlow();
    return true;
  }

  private flush(): void {
    if (this.phase !== 'ready') return;
    if (this.congested()) { this.schedule(); return; }
    for (const [id, sync] of this.feeds) if (sync.dirty) this.flushFeed(id);
  }

  private flushFeed(id: string): void {
    const sync = this.feeds.get(id);
    if (!sync) return;
    sync.dirty = false;
    const wire = sync.feed.items().map(wireItem);
    const ops = sync.sent ? diffItems(sync.sent, wire) : 'snapshot';
    sync.sent = wire;
    if (ops === 'snapshot') this.send({ t: 'snapshot', feed: id, items: wire });
    else if (ops.length) this.send({ t: 'items', feed: id, ops });
  }

  private flushStatus(): void {
    const status = this.host.status();
    if (this.phase !== 'ready' || !status) return;
    if (this.congested()) { this.statusChanged(); return; }
    this.sendStatus(status);
  }

  private sendStatus(status: SessionStatus): void {
    const json = JSON.stringify(status);
    if (json === this.statusSent) return;
    this.statusSent = json;
    this.statusAt = Date.now();
    this.send({ t: 'status', status });
  }

  /** Closes the peer once its unsent bytes stayed over LIMITS.slowBytes for LIMITS.slowMs. */
  private watchSlow(): void {
    if (this.link.buffered() <= LIMITS.slowBytes) { this.slowSince = undefined; return; }
    const now = Date.now();
    this.slowSince ??= now;
    if (now - this.slowSince >= LIMITS.slowMs) this.close(CloseCode.tooSlow, 'Reading too slowly');
  }

  private tick(): void {
    if (Date.now() - this.heardAt >= SILENCE_MS) { this.close(CloseCode.normal, `Nothing heard for ${SILENCE_MS / 1000} s`); return; }
    this.watchSlow();
  }

  private ended(): void {
    if (this.phase === 'closed') return;
    const wasVisible = this.visible;
    this.phase = 'closed';
    clearTimeout(this.helloTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.statusTimer);
    clearInterval(this.ticker);
    if (wasVisible) this.visibleAt = Date.now();
    this.host.closed(this);
  }
}
