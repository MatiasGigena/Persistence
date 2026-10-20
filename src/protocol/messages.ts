// Wire protocol v1: every message between the server (src/server/) and its clients (src/client/, src/web/).
// docs/protocol.md is the prose spec; this file is its types and constants. Shared by Node and the browser, so it
// holds plain types and constants only: no Node or DOM imports, and no runtime imports at all.
import type { ChatItem, ModelChoice, NoticeLevel, SessionStatus, ViewLine } from '../ui/types.ts';

export type { AgentStatus, ChatItem, MemoryStats, ModelChoice, NoticeLevel, SessionStatus, ViewLine } from '../ui/types.ts';

/** Pi's feed, open on every connection from `ready` on. Agent feeds get their id from `feed.open`. */
export const ROOT_FEED = 'root';

/** Sizes and timings both sides rely on. Lengths are in UTF-16 code units (JavaScript string length). */
export const LIMITS = {
  /** Longest client message: one WebSocket text frame, or one NDJSON line without its newline. */
  clientMessage: 4 * 1024 * 1024,
  /** Tool `output` and `args` longer than this are clipped on the wire, head and tail kept (diff.ts `clip`). */
  clip: 64 * 1024,
  /** The server flushes each peer's state at most this long after a change. */
  flushMs: 50,
  /** A peer's flushes wait while more than this many bytes are still unsent to it. */
  highWater: 256 * 1024,
  /** A peer whose unsent bytes stay above this for `slowMs` is closed with CloseCode.tooSlow. */
  slowBytes: 8 * 1024 * 1024,
  slowMs: 60_000,
  /** A connection without a valid `hello` this long after it opens is closed with CloseCode.version. */
  helloMs: 10_000,
  /** Clients ping this often while open; a client that gets no message for 2 × this reconnects. */
  pingMs: 25_000,
} as const;

/** Error codes of a failed `res`. A client treats a code it does not know as `failed`. */
export const ErrorCode = {
  /** Malformed message, missing or invalid params, or `tools.set` enabling without its `confirm`. */
  badRequest: 'bad_request',
  /** An op this server does not know. */
  unknownOp: 'unknown_op',
  /** No such agent, feed, memory line or device. */
  notFound: 'not_found',
  /** Not allowed for this peer: `admin.*` from the web, `push.*` from the socket, tools when the policy is off. */
  forbidden: 'forbidden',
  /** The op ran and failed; `message` says why, readably. */
  failed: 'failed',
  /** Not possible right now: the memory is not open, the server is shutting down. Retrying later may work. */
  unavailable: 'unavailable',
  /** A request before `hello` was answered: the connection has no protocol version yet. */
  version: 'version',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCode);

/**
 * Why a connection ends: the WebSocket close code, and the `code` of the `bye` the server sends first on either
 * transport. A client reconnects (with backoff) after any end except `version` and `unauthorized`.
 */
export const CloseCode = {
  /** The client detached, or the server closed an idle connection. */
  normal: 1000,
  /** The server is restarting or shutting down. */
  restart: 1012,
  /** No valid `hello`, or another protocol version. Reload (web) or upgrade; do not retry as is. */
  version: 4000,
  /** The device was revoked, or the login is no longer allowed. Pair again. */
  unauthorized: 4001,
  /** The peer read too slowly (LIMITS.slowBytes for LIMITS.slowMs). Reconnecting gives a fresh snapshot. */
  tooSlow: 4008,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Which transport a peer came in on; it decides the ops it may call. */
export type Peer = 'socket' | 'web';

/** Who may turn the coding tools on remotely, and when they turn themselves off. */
export interface ToolsPolicy {
  /** `confirm`: web peers may enable the tools with `confirm: 'enable-tools'`; `off`: only socket peers may. */
  readonly remote: 'confirm' | 'off';
  /** The server turns the tools off after this many minutes without a run. */
  readonly idleMinutes: number;
}

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export interface PushSubscriptionJson {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** A paired web device, as `admin.devices` lists it. Times are milliseconds since the epoch. */
export interface Device {
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeen?: number;
}

/** The params of an op that takes none. Unknown params are ignored, as everywhere. */
export type NoParams = Readonly<Record<string, never>>;

/** Every request op: its params and its successful result. `null` results carry nothing. */
export interface Ops {
  /**
   * Sends text to Pi: starts a run, or follows up the running one. With `requestId`, a repeat of the same id is
   * admitted once (pi-durable's submission dedup), so a client may resend after losing the `res` to a reconnect.
   */
  readonly send: { readonly params: { readonly text: string; readonly requestId?: string }; readonly result: null };
  /** Interrupts Pi's running work (Esc). */
  readonly abort: { readonly params: NoParams; readonly result: null };
  /** Stops one agent and its sub agents, or all agents without `name`. Names stopped, sub agents first. */
  readonly stopAgents: { readonly params: { readonly name?: string }; readonly result: { readonly names: readonly string[] } };
  /** Opens an agent's conversation as a feed; a `snapshot` for it follows the `res`. `not_found` for no such agent. */
  readonly 'feed.open': { readonly params: { readonly name: string }; readonly result: { readonly feed: string } };
  /** Closes an agent feed this peer opened. The root feed cannot be closed. */
  readonly 'feed.close': { readonly params: { readonly feed: string }; readonly result: null };
  /** Asks for a fresh `snapshot` of a feed, after `applyOps` returned 'resync'. */
  readonly 'feed.resync': { readonly params: { readonly feed: string }; readonly result: null };
  /** The memory view, oldest first; empty while the memory is not open. */
  readonly 'memory.view': { readonly params: NoParams; readonly result: { readonly lines: readonly ViewLine[] } };
  /** The zoom tool's text for line id+n. `not_found` for no such line. */
  readonly 'memory.zoom': { readonly params: { readonly id: number; readonly n: number }; readonly result: { readonly text: string } };
  /** Models to pick from, the current one included. */
  readonly models: { readonly params: NoParams; readonly result: { readonly models: readonly ModelChoice[] } };
  /** Switches Pi and its agents to a model, and saves it as the default. `failed` with a readable message. */
  readonly 'model.set': { readonly params: { readonly provider: string; readonly id: string }; readonly result: null };
  /** Coding tools on or off for this server run. Enabling needs `confirm: 'enable-tools'`. */
  readonly 'tools.set': { readonly params: { readonly enabled: boolean; readonly confirm?: 'enable-tools' }; readonly result: null };
  /** The reasoning efforts the current model takes, lowest first. */
  readonly 'thinking.levels': { readonly params: NoParams; readonly result: { readonly levels: readonly string[] } };
  /** Sets Pi's and its agents' reasoning effort, and saves it as the default. `failed` with a readable message. */
  readonly 'thinking.set': { readonly params: { readonly level: string }; readonly result: null };
  /** Web only: Web Push to this subscription while no client is visible. */
  readonly 'push.subscribe': { readonly params: { readonly subscription: PushSubscriptionJson }; readonly result: null };
  /** Web only: no more pushes to this endpoint. */
  readonly 'push.unsubscribe': { readonly params: { readonly endpoint: string }; readonly result: null };
  /** Socket only: an online backup into `out` (default: the configured backup directory). */
  readonly 'admin.backup': { readonly params: { readonly out?: string }; readonly result: { readonly path: string; readonly bytes: number } };
  /** Socket only: a one-time pairing code for a new web device. */
  readonly 'admin.pair': { readonly params: NoParams; readonly result: { readonly code: string; readonly expiresAt: number } };
  /** Socket only: the paired web devices. */
  readonly 'admin.devices': { readonly params: NoParams; readonly result: { readonly devices: readonly Device[] } };
  /** Socket only: forgets a device and closes its connections with CloseCode.unauthorized. */
  readonly 'admin.revoke': { readonly params: { readonly name: string }; readonly result: null };
}
export type Op = keyof Ops;
export type Params<O extends Op> = Ops[O]['params'];
export type Result<O extends Op> = Ops[O]['result'];

/** Every op, in the order of `Ops`. */
export const OPS: readonly Op[] = [
  'send', 'abort', 'stopAgents', 'feed.open', 'feed.close', 'feed.resync', 'memory.view', 'memory.zoom', 'models',
  'model.set', 'tools.set', 'thinking.levels', 'thinking.set', 'push.subscribe', 'push.unsubscribe', 'admin.backup', 'admin.pair', 'admin.devices',
  'admin.revoke',
];
/** Ops only socket peers may call; web peers get `forbidden`. */
export const SOCKET_ONLY: ReadonlySet<Op> = new Set<Op>(['admin.backup', 'admin.pair', 'admin.devices', 'admin.revoke']);
/** Ops only web peers may call; socket peers get `forbidden`. */
export const WEB_ONLY: ReadonlySet<Op> = new Set<Op>(['push.subscribe', 'push.unsubscribe']);
/** What `tools.set` must carry to enable the tools: the client asked its user first. */
export const ENABLE_TOOLS = 'enable-tools';

// ------------------------------------------------------------------------------------------------ client → server

/** First message on every connection. The server answers `welcome`, `status`, the root `snapshot`, then `ready`. */
export interface Hello {
  readonly t: 'hello';
  readonly protocol: number;
  /** Free text for logs and the journal, e.g. "pi-durable-tui 0.1.0" or "web". */
  readonly client: string;
  /** Whether the user can see this client now (a visible tab, a terminal). Push waits while any client is visible. */
  readonly visible: boolean;
}

/** A request; answered by exactly one `res` with the same `id`. Ids are the client's, unique per connection. */
export interface RequestOf<O extends Op> {
  readonly t: 'req';
  readonly id: number;
  readonly op: O;
  readonly params: Params<O>;
}
export type Request = { readonly [O in Op]: RequestOf<O> }[Op];

/** The client's visibility changed. */
export interface Visible { readonly t: 'visible'; readonly visible: boolean }

/** Liveness; the server answers `pong` with the same `n`. */
export interface Ping { readonly t: 'ping'; readonly n: number }

export type ClientMessage = Hello | Request | Visible | Ping;

// ------------------------------------------------------------------------------------------------ server → client

/** The answer to `hello`. */
export interface Welcome {
  readonly t: 'welcome';
  readonly protocol: number;
  /** The server's version (pi-durable's). */
  readonly server: string;
  /** Changes on every server start: a client seeing a new value knows the server restarted. */
  readonly boot: string;
  /** A hash of the web app's files: a web client seeing a new value reloads. */
  readonly assets: string;
  readonly peer: Peer;
  /** The directory coding tools work in; the attached TUI completes paths from it. */
  readonly cwd: string;
  readonly tools: ToolsPolicy;
  /** The VAPID public key (base64url) for `PushManager.subscribe`; absent when push is unavailable or not web. */
  readonly pushKey?: string;
  /** This web device's name; absent for socket peers. */
  readonly device?: string;
}

/** The initial state (welcome, status, root snapshot) is complete. */
export interface Ready { readonly t: 'ready' }

/** The whole status, whenever it changed since the last one sent. */
export interface StatusMessage { readonly t: 'status'; readonly status: SessionStatus }

/** A feed's whole item list: replaces the client's mirror of it. */
export interface Snapshot { readonly t: 'snapshot'; readonly feed: string; readonly items: readonly ChatItem[] }

/** Changes to a feed since the last `snapshot` or `items` for it, applied in order (mirror.ts `applyOps`). */
export interface Items { readonly t: 'items'; readonly feed: string; readonly ops: readonly ItemOp[] }

/** The server ended a feed (its agent is gone, or the feed closed): no more messages for it. */
export interface FeedEnd { readonly t: 'feed.end'; readonly feed: string; readonly reason: string }

/** A host notice for this client to show (UiSession `onNotice`). */
export interface Notice { readonly t: 'notice'; readonly text: string; readonly level: NoticeLevel }

/** A successful answer; `op` echoes the request's, so the result can be checked. */
export interface ResponseOf<O extends Op> {
  readonly t: 'res';
  readonly id: number;
  readonly op: O;
  readonly ok: true;
  readonly result: Result<O>;
}
/** A failed answer. `id` is -1 when the request's id could not be read. */
export interface ErrorResponse {
  readonly t: 'res';
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly code: ErrorCode; readonly message: string };
}
export type Response = { readonly [O in Op]: ResponseOf<O> }[Op] | ErrorResponse;

export interface Pong { readonly t: 'pong'; readonly n: number }

/** The server's last message before it ends the connection; a WebSocket close frame repeats the code. */
export interface Bye { readonly t: 'bye'; readonly code: number; readonly reason: string }

export type ServerMessage = Welcome | Ready | StatusMessage | Snapshot | Items | FeedEnd | Notice | Response | Pong | Bye;

// ------------------------------------------------------------------------------------------------ item ops

/** The string fields an `append` may grow: `text` of every kind but tool; `output` and `args` of a tool. */
export type AppendField = 'text' | 'output' | 'args';

/**
 * One change to a feed's items:
 * - `put`: the item replaces the one with its id in place; a new id goes before `before` (which must exist), or at
 *   the end without it.
 * - `append`: the item's `field` was `at` code units long, and `text` follows; nothing else changed.
 * - `del`: the item leaves the list.
 */
export type ItemOp =
  | { readonly op: 'put'; readonly item: ChatItem; readonly before?: string }
  | { readonly op: 'append'; readonly id: string; readonly field: AppendField; readonly at: number; readonly text: string }
  | { readonly op: 'del'; readonly id: string };
