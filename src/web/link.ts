// The web app's link to the server: one WebSocket at a time, with hello, ping, requests, and reconnect with backoff
// (docs/protocol.md "Reconnect and resume"). No DOM types: the socket comes from a `connect` function, so tests drive
// the state machine with a fake socket and Node's mock timers.
import { CloseCode, LIMITS } from '../protocol/messages.ts';
import type { Op, Params, ResponseOf, Result, ServerMessage } from '../protocol/messages.ts';
import { PROTOCOL } from '../protocol/version.ts';
import { isParseError, parseServerMessage } from '../protocol/parse.ts';
import { RequestError } from '../protocol/request-error.ts';

/** What the link needs of a socket. */
export interface SocketHandle {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** The socket's events, as `connect` must deliver them. `close` comes once, after an `open` or instead of one. */
export interface SocketEvents {
  open(): void;
  message(text: string): void;
  close(code: number): void;
}

export type Connect = (events: SocketEvents) => SocketHandle;

/** Checked before each connection attempt (the web app's `/api/me`). */
export type GateProbe = () => Promise<'ok' | 'offline' | 'unpaired' | 'forbidden'>;

/**
 * - `connecting`: the first attempt, nothing shown yet.
 * - `ready`: the initial state arrived; requests go through.
 * - `reconnecting`: the server did not answer or the link dropped; retrying with backoff.
 * - `offline`: the gate could not reach the server at all (no tailnet); retrying with backoff.
 * - `closed`: for good, see `closedBy`.
 */
export type LinkState = 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'closed';

/** Why a link closed for good. */
export type ClosedBy = 'version' | 'unauthorized' | 'unpaired' | 'forbidden' | 'stopped';

/** A failed request: the server's error code, or `lost` when the link dropped first. */

export interface LinkOptions {
  readonly connect: Connect;
  readonly gate?: GateProbe;
  /** `hello.client`. */
  readonly client: string;
  readonly visible: () => boolean;
  /** Every server message but `res` and `pong`, in order. */
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onState: (state: LinkState) => void;
  /** Jitter source; default Math.random. */
  readonly random?: () => number;
}

/** Backoff before reconnect attempt `attempt` (0 first): 0.5 s doubling to 10 s, ±20% jitter. */
export function backoff(attempt: number, random: () => number): number {
  const base = Math.min(10_000, 500 * 2 ** attempt);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** A successful response whose op is `op`; the parser already checked each op's result shape. */
const answers = <O extends Op>(res: { readonly op: Op }, op: O): res is ResponseOf<O> => res.op === op;

interface Waiter {
  readonly settle: (res: Extract<ServerMessage, { t: 'res' }> | RequestError) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class Link {
  private readonly options: LinkOptions;
  private socket: SocketHandle | undefined;
  private current: LinkState = 'connecting';
  private why: ClosedBy | undefined;
  private endedWith: number | undefined;
  private attempt = 0;
  private nextId = 0;
  private pingN = 0;
  private bye: number | undefined;
  private retry: Timer | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private dead: Timer | undefined;
  private readonly waiters = new Map<number, Waiter>();
  /** Bumped per attempt, so events of an abandoned socket are ignored. */
  private generation = 0;

  constructor(options: LinkOptions) {
    this.options = options;
  }

  get state(): LinkState { return this.current; }
  get closedBy(): ClosedBy | undefined { return this.why; }
  /** The server's `bye` code, else the close code (0: it went silent), that ended the last connection. */
  get droppedWith(): number | undefined { return this.endedWith; }

  /** Starts connecting. */
  start(): void {
    void this.open();
  }

  /** Closes for good (WebSocket 1000). */
  stop(): void {
    this.finish('stopped');
  }

  /**
   * The browser came online or the app came to the front (a phone woke up). Ready: ping at once, and drop the link
   * if nothing answers within wakeMs, since a socket that slept is usually dead without a close. Reconnecting or
   * offline: start a fresh attempt now, with the backoff reset, abandoning one that hangs since the sleep.
   */
  poke(): void {
    if (this.current === 'ready') {
      this.socket?.send(JSON.stringify({ t: 'ping', n: this.pingN++ }));
      this.deadline(LIMITS.wakeMs);
      return;
    }
    if (this.current !== 'reconnecting' && this.current !== 'offline') return;
    clearTimeout(this.retry);
    this.retry = undefined;
    const hung = this.socket;
    this.generation++;
    this.teardown();
    hung?.close(CloseCode.normal, 'retry');
    this.attempt = 0;
    void this.open();
  }

  /** Tells the server whether the user can see this client. */
  visible(visible: boolean): void {
    if (this.current === 'ready') this.socket?.send(JSON.stringify({ t: 'visible', visible }));
  }

  /** Sends a request; resolves with its result, rejects with a RequestError. Only while `ready`. */
  request<O extends Op>(op: O, params: Params<O>): Promise<Result<O>> {
    const socket = this.socket;
    if (this.current !== 'ready' || !socket) return Promise.reject(new RequestError('disconnected', 'Not connected.'));
    const id = this.nextId++;
    return new Promise<Result<O>>((resolve, reject) => {
      this.waiters.set(id, {
        settle: res => {
          if (res instanceof RequestError) reject(res);
          else if (!res.ok) reject(new RequestError(res.error.code, res.error.message));
          else if (answers(res, op)) resolve(res.result);
          else reject(new RequestError('failed', `The server answered ${res.op} to ${op}.`));
        },
      });
      socket.send(JSON.stringify({ t: 'req', id, op, params }));
    });
  }

  private setState(state: LinkState): void {
    if (state === this.current) return;
    this.current = state;
    this.options.onState(state);
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    if (this.options.gate) {
      let gate: Awaited<ReturnType<GateProbe>>;
      let timer: Timer | undefined;
      const late = new Promise<'offline'>(resolve => { timer = setTimeout(() => resolve('offline'), LIMITS.connectMs); });
      try { gate = await Promise.race([this.options.gate(), late]); } catch { gate = 'offline'; } finally { clearTimeout(timer); }
      if (generation !== this.generation || this.current === 'closed') return;
      if (gate === 'unpaired' || gate === 'forbidden') { this.finish(gate); return; }
      if (gate === 'offline') { this.schedule('offline'); return; }
    }
    this.bye = undefined;
    this.nextId = 0;
    const live = (): boolean => generation === this.generation;
    this.socket = this.options.connect({
      open: () => { if (live()) this.opened(); },
      message: text => { if (live()) this.receive(text); },
      close: code => { if (live()) this.dropped(code); },
    });
    // A socket that neither opens nor closes (started as the phone went to sleep) would otherwise wait forever.
    this.deadline(LIMITS.connectMs);
  }

  private opened(): void {
    this.socket?.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, client: this.options.client, visible: this.options.visible() }));
    this.ping = setInterval(() => this.socket?.send(JSON.stringify({ t: 'ping', n: this.pingN++ })), LIMITS.pingMs);
    this.alive();
  }

  /** Any message proves the link alive; silence for 2 × pingMs means it is dead. */
  private alive(): void {
    this.deadline(2 * LIMITS.pingMs);
  }

  /** Drops the socket unless a message arrives within `ms`. */
  private deadline(ms: number): void {
    clearTimeout(this.dead);
    this.dead = setTimeout(() => {
      this.socket?.close(CloseCode.normal, 'no answer');
      this.dropped(0);
    }, ms);
  }

  private receive(text: string): void {
    this.alive();
    const msg = parseServerMessage(text);
    if (isParseError(msg)) {
      // A response that did not parse still settles its request.
      if (msg.id !== undefined) this.settle(msg.id, new RequestError('failed', `Unreadable answer: ${msg.message}`));
      return;
    }
    if (msg.t === 'res') { this.settle(msg.id, msg); return; }
    if (msg.t === 'pong') return;
    if (msg.t === 'bye') this.bye = msg.code;
    if (msg.t === 'ready') { this.attempt = 0; this.setState('ready'); }
    this.options.onMessage(msg);
  }

  private settle(id: number, res: Extract<ServerMessage, { t: 'res' }> | RequestError): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.settle(res);
  }

  /** The socket closed (or went silent): stop for good after 4000 and 4001, else reconnect. */
  private dropped(closeCode: number): void {
    this.generation++;
    this.teardown();
    const code = this.endedWith = this.bye ?? closeCode;
    if (code === CloseCode.version) { this.finish('version'); return; }
    if (code === CloseCode.unauthorized) { this.finish('unauthorized'); return; }
    this.schedule('reconnecting');
  }

  private schedule(state: 'reconnecting' | 'offline'): void {
    this.setState(state);
    const delay = backoff(this.attempt++, this.options.random ?? Math.random);
    this.retry = setTimeout(() => { this.retry = undefined; void this.open(); }, delay);
  }

  /** Stops timers, forgets the socket, and rejects pending requests. */
  private teardown(): void {
    clearInterval(this.ping);
    clearTimeout(this.dead);
    this.ping = this.dead = undefined;
    this.socket = undefined;
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiters) waiter.settle(new RequestError('disconnected', 'Connection lost.'));
  }

  private finish(why: ClosedBy): void {
    if (this.current === 'closed') return;
    const socket = this.socket;
    this.generation++;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.teardown();
    socket?.close(CloseCode.normal, 'closed');
    this.why = why;
    this.setState('closed');
  }
}
