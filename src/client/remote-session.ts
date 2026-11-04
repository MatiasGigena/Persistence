// A UiSession over the wire protocol (docs/protocol.md): the terminal UI attached to `pi-durable serve` sees the
// same contract as in process. Feeds are mirrors rebuilt from `snapshot` and `items` (mirror.ts `applyOps`), the
// status is the last one sent, and every method is a request. A reconnect gets a fresh snapshot and re-opens the
// agent feeds that were open.
import { ENABLE_TOOLS, ROOT_FEED } from '../protocol/messages.ts';
import type {
  ErrorCode, Op, Params, RequestOf, Response, ResponseOf, Result, ServerMessage, Welcome,
} from '../protocol/messages.ts';
import { applyOps } from '../protocol/mirror.ts';
import type { AttachedLink, LinkState } from '../ui/tui/app.ts';
import type { ArchiveTarget, ChatFeed, ChatItem, ModelChoice, NoticeLevel, SendOptions, SessionStatus, UiSession, ViewLine } from '../ui/types.ts';
import type { MachineTarget } from '../protocol/machines.ts';
import type { LinkStatus, Outgoing } from './unix-link.ts';

/** What the session needs of its link; `ClientLink` (unix-link.ts) is one. */
export interface ServerLink {
  state(): LinkStatus;
  closedBecause(): string | undefined;
  onChange(listener: () => void): () => void;
  onMessage(listener: (message: ServerMessage) => void): () => void;
  send(message: Outgoing): boolean;
  close(): void;
}

/** A failed request: the server's error code and its readable message. */
export class RemoteError extends Error {
  readonly code: ErrorCode | 'disconnected' | 'timeout';
  constructor(code: RemoteError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface RemoteSessionOptions {
  /** A request without an answer this long rejects. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Prefix of `send` request ids; default a random one per session. */
  readonly clientId?: string;
  readonly target?: MachineTarget;
  readonly requireMachines?: boolean;
  readonly machineToolsEnabled?: () => boolean;
  readonly setMachineTools?: (enabled: boolean) => Promise<void>;
}

/** Shown before the first status arrives; the client waits for `ready()` before showing anything. */
const NO_STATUS: SessionStatus = {
  model: '…', thinkingLevel: '…', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [],
};

/** One feed's mirror. Agent feeds keep their name, to be opened again after a reconnect. */
class Mirror {
  id: string;
  readonly name: string | undefined;
  items: readonly ChatItem[] = [];
  /** Ignore `items` until the next snapshot: none yet on this connection, or a resync is asked. */
  waiting = true;
  ended = false;
  refs = 0;
  readonly listeners = new Set<() => void>();
  constructor(id: string, name?: string) { this.id = id; this.name = name; }
  set(items: readonly ChatItem[]): void {
    this.items = items;
    for (const listener of [...this.listeners]) listener();
  }
  feed(close: () => Promise<void>): ChatFeed {
    return {
      items: () => this.items,
      subscribe: listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
      close,
    };
  }
}

/** A request in flight. `send`s survive a reconnect (resent with their requestId); the rest reject. */
interface Pending {
  readonly op: Op;
  readonly message: (id: number) => RequestOf<Op>;
  /** Unset while waiting for a connection to send it on. */
  id: number | undefined;
  readonly settle: (response: Response) => void;
  readonly fail: (error: RemoteError) => void;
  readonly timer: NodeJS.Timeout;
}

/** `response` answers `op` successfully, so its result is that op's. */
const answers = <O extends Op>(response: Response | ResponseOf<O>, op: O): response is ResponseOf<O> =>
  response.ok && response.op === op;

const random = (): string => crypto.randomUUID().slice(0, 8);

/**
 * The UiSession of a server, over `link`. Subscribe before the link starts: the session reads every message,
 * the first welcome included. `ready()` resolves at the first `ready`, when the status and Pi's feed are whole.
 */
export class RemoteSession implements UiSession {
  readonly chat: ChatFeed;
  /** For TuiInfo.attached: `open` once a connection is ready, `reconnecting` until then, `closed` for good. */
  readonly attached: AttachedLink;
  private readonly link: ServerLink;
  private readonly timeoutMs: number;
  private readonly options: RemoteSessionOptions;
  private readonly clientId: string;
  private readonly root = new Mirror(ROOT_FEED);
  /** Mirrors by their feed id on the current connection. */
  private readonly feeds = new Map<string, Mirror>();
  /** Open agent mirrors, re-opened by name after a reconnect. */
  private readonly agents = new Set<Mirror>();
  private readonly pending = new Set<Pending>();
  private readonly byId = new Map<number, Pending>();
  private current: SessionStatus = NO_STATUS;
  private greeting: Welcome | undefined;
  private connected = false;
  private detaching = false;
  private nextId = 0;
  private sends = 0;
  private readonly first = Promise.withResolvers<void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(text: string, level: NoticeLevel) => void>();
  private readonly linkListeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];

  constructor(link: ServerLink, options: RemoteSessionOptions = {}) {
    this.link = link;
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.clientId = options.clientId ?? `tui-${random()}`;
    this.chat = this.root.feed(() => Promise.resolve());
    this.feeds.set(ROOT_FEED, this.root);
    this.first.promise.catch(() => undefined);
    this.attached = {
      state: () => this.linkState(),
      onChange: listener => { this.linkListeners.add(listener); return () => this.linkListeners.delete(listener); },
    };
    this.unsubscribes = [link.onMessage(message => this.receive(message)), link.onChange(() => this.linkChanged())];
  }

  /** Resolves at the first `ready`; rejects when the link closes before it. */
  ready(): Promise<void> { return this.first.promise; }

  /** The current connection's welcome (its `cwd`, tools policy, boot). */
  welcome(): Welcome | undefined { return this.greeting; }

  /** Shows a notice from this process (a console warning while the TUI runs) as host notices do. */
  notify(text: string, level: NoticeLevel = 'info'): void {
    for (const listener of [...this.noticeListeners]) listener(text, level);
  }

  /** Detaches: ends the link, and rejects whatever is pending. The server keeps working. */
  close(): Promise<void> {
    if (this.detaching) return Promise.resolve();
    this.detaching = true;
    this.link.close();
    this.failAll(() => true, 'Detached from the server');
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    return Promise.resolve();
  }

  status(): SessionStatus {
    return this.options.target ? { ...this.current, machine: this.options.target,
      toolsEnabled: this.current.toolsEnabled && (this.options.machineToolsEnabled?.() ?? false) } : this.current;
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onNotice(listener: (text: string, level: NoticeLevel) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** Admitted once even if resent: the requestId (given, or made here) stays with the text across reconnects. */
  async send(text: string, { requestId = `${this.clientId}-${++this.sends}`, steer = false, target = this.options.target, images }: SendOptions = {}): Promise<void> {
    await this.request('send', { text, requestId, ...steer ? { steer } : {}, ...target ? { target } : {}, ...images?.length ? { images } : {} });
  }

  async abort(): Promise<void> { await this.request('abort', {}); }

  async stopAgents(name?: string): Promise<readonly string[]> {
    return (await this.request('stopAgents', name === undefined ? {} : { name })).names;
  }

  async archiveAgents(target: ArchiveTarget): Promise<readonly string[]> {
    return (await this.request('agents.archive', target)).names;
  }

  async restoreAgent(name: string): Promise<readonly string[]> {
    return (await this.request('agents.restore', { name })).names;
  }

  async agentChat(name: string): Promise<ChatFeed | undefined> {
    const known = [...this.agents].find(mirror => !mirror.ended && mirror.name?.toLowerCase() === name.toLowerCase());
    if (known) return this.handle(known);
    try {
      // The snapshot follows the res at once, so the mirror must exist when the res is read, not a tick later.
      const { feed } = await this.request('feed.open', { name }, result => this.track(result.feed, name));
      const mirror = [...this.agents].find(each => each.id === feed);
      return mirror && this.handle(mirror);
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  async memoryView(): Promise<readonly ViewLine[]> { return (await this.request('memory.view', {})).lines; }

  async zoom(id: number, n: number): Promise<string> { return (await this.request('memory.zoom', { id, n })).text; }

  async models(): Promise<readonly ModelChoice[]> { return (await this.request('models', {})).models; }

  async setModel(provider: string, id: string): Promise<void> { await this.request('model.set', { provider, id }); }

  /** The TUI asked its user before turning tools on, so `enabled` carries the confirmation. */
  async setTools(enabled: boolean): Promise<void> {
    try {
      await this.options.setMachineTools?.(enabled);
      await this.request('tools.set', enabled ? { enabled, confirm: ENABLE_TOOLS } : { enabled });
    } catch (error) {
      if (enabled) await this.options.setMachineTools?.(false).catch(() => undefined);
      throw error;
    }
    for (const listener of [...this.statusListeners]) listener();
  }

  async thinkingLevels(): Promise<readonly string[]> { return (await this.request('thinking.levels', {})).levels; }

  async setThinkingLevel(level: string): Promise<void> { await this.request('thinking.set', { level }); }

  // ---------------------------------------------------------------------------------------------- requests

  /**
   * Sends `op` and resolves with its result. `hook` runs on the result as the `res` is read, before any later
   * message. Rejects with a RemoteError: the server's, `timeout`, or `disconnected` (a dropped link; `send`s wait
   * for the next connection instead).
   */
  request<O extends Op>(op: O, params: Params<O>, hook?: (result: Result<O>) => void): Promise<Result<O>> {
    if (this.detaching || this.link.state() === 'closed') {
      return Promise.reject(new RemoteError('disconnected', 'Not connected to the server'));
    }
    if (!this.connected && op !== 'send') {
      return Promise.reject(new RemoteError('disconnected', 'Not connected to the server; reconnecting…'));
    }
    const { promise, resolve, reject } = Promise.withResolvers<Result<O>>();
    const entry: Pending = {
      op,
      message: id => ({ t: 'req', id, op, params }),
      id: undefined,
      settle: response => {
        this.forget(entry);
        if (!response.ok) { reject(new RemoteError(response.error.code, response.error.message)); return; }
        if (!answers(response, op)) { reject(new RemoteError('failed', `The server answered ${op} with ${response.op}`)); return; }
        hook?.(response.result);
        resolve(response.result);
      },
      fail: error => { this.forget(entry); reject(error); },
      timer: setTimeout(() => entry.fail(new RemoteError('timeout', `The server did not answer ${op} within ${Math.round(this.timeoutMs / 1000)} s`)),
        this.timeoutMs),
    };
    this.pending.add(entry);
    if (this.connected) this.transmit(entry);
    return promise;
  }

  private transmit(entry: Pending): void {
    const id = this.nextId++;
    entry.id = id;
    this.byId.set(id, entry);
    if (!this.link.send(entry.message(id))) {
      this.byId.delete(id);
      entry.id = undefined;
    }
  }

  private forget(entry: Pending): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry);
    if (entry.id !== undefined) this.byId.delete(entry.id);
  }

  private failAll(which: (entry: Pending) => boolean, message: string): void {
    for (const entry of [...this.pending]) if (which(entry)) entry.fail(new RemoteError('disconnected', message));
  }

  // ---------------------------------------------------------------------------------------------- feeds

  /** The agent mirror for feed `id` on this connection, made when `feed.open` answers. */
  private track(id: string, name: string): void {
    const mirror = this.feeds.get(id) ?? new Mirror(id, name);
    mirror.waiting = true;
    this.feeds.set(id, mirror);
    this.agents.add(mirror);
  }

  /** One handle on an agent mirror; the feed closes on the server when its last handle closes. */
  private handle(mirror: Mirror): ChatFeed {
    mirror.refs++;
    let closed = false;
    return mirror.feed(async () => {
      if (closed) return;
      closed = true;
      if (--mirror.refs > 0) return;
      this.agents.delete(mirror);
      if (this.feeds.get(mirror.id) !== mirror) return;
      this.feeds.delete(mirror.id);
      if (mirror.ended || !this.connected) return;
      await this.request('feed.close', { feed: mirror.id }).catch(() => undefined);
    });
  }

  /** After `ready`: the agent feeds open before the reconnect, opened again (their ids may differ). */
  private reopen(): void {
    for (const mirror of this.agents) {
      if (mirror.ended || mirror.name === undefined) continue;
      const { name } = mirror;
      this.request('feed.open', { name }, ({ feed }) => {
        mirror.id = feed;
        // Its last handle closed while the open was on its way: close it again.
        if (!this.agents.has(mirror)) { this.request('feed.close', { feed }).catch(() => undefined); return; }
        mirror.waiting = true;
        this.feeds.set(feed, mirror);
      }).catch((error: unknown) => {
        if (error instanceof RemoteError && error.code === 'not_found') mirror.ended = true;
      });
    }
  }

  // ---------------------------------------------------------------------------------------------- messages

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        if (this.options.requireMachines && !message.machines) {
          const error = new RemoteError('failed', 'This server lacks machine routing. Update and restart its pi-durable service first; no local chat was opened.');
          this.first.reject(error);
          this.notify(error.message, 'error');
          this.link.close();
          return;
        }
        const restarted = this.greeting !== undefined && this.greeting.boot !== message.boot;
        this.greeting = message;
        this.feeds.clear();
        this.feeds.set(ROOT_FEED, this.root);
        for (const mirror of [this.root, ...this.agents]) mirror.waiting = true;
        if (restarted) this.notify('The server restarted.');
        return;
      }
      case 'ready':
        this.connected = true;
        this.first.resolve();
        for (const entry of this.pending) if (entry.id === undefined) this.transmit(entry);
        this.reopen();
        this.linkEvent();
        return;
      case 'status':
        this.current = message.status;
        for (const listener of [...this.statusListeners]) listener();
        return;
      case 'snapshot': {
        const mirror = this.feeds.get(message.feed);
        if (!mirror) return;
        mirror.waiting = false;
        mirror.set(message.items);
        return;
      }
      case 'items': {
        const mirror = this.feeds.get(message.feed);
        if (!mirror || mirror.waiting) return;
        const items = applyOps(mirror.items, message.ops);
        if (items !== 'resync') { mirror.set(items); return; }
        // Keep the last good mirror and ignore this feed's items until the snapshot asked for.
        mirror.waiting = true;
        this.request('feed.resync', { feed: mirror.id }).catch(() => undefined);
        return;
      }
      case 'feed.end': {
        const mirror = this.feeds.get(message.feed);
        if (!mirror || mirror === this.root) return;
        mirror.ended = true;
        this.feeds.delete(message.feed);
        return;
      }
      case 'notice':
        this.notify(message.text, message.level);
        return;
      case 'res':
        this.byId.get(message.id)?.settle(message);
        return;
      case 'pong': case 'bye':
        return;
    }
  }

  private linkChanged(): void {
    const state = this.link.state();
    if (state === 'open' || state === 'connecting') return;
    this.connected = false;
    if (state === 'reconnecting') {
      // A `send` may have been admitted; it goes again with its requestId, so it is admitted once.
      for (const entry of this.pending) {
        if (entry.op !== 'send' || entry.id === undefined) continue;
        this.byId.delete(entry.id);
        entry.id = undefined;
      }
      this.failAll(entry => entry.op !== 'send', 'Connection to the server lost');
    } else {
      this.failAll(() => true, 'Connection to the server closed');
      const reason = this.link.closedBecause();
      if (!this.detaching && reason) this.notify(reason, 'error');
      this.first.reject(new Error(reason ?? 'The connection to the server closed'));
    }
    this.linkEvent();
  }

  private linkState(): LinkState {
    const state = this.link.state();
    if (state === 'closed') return 'closed';
    return state === 'open' && this.connected ? 'open' : 'reconnecting';
  }

  private linkEvent(): void {
    for (const listener of [...this.linkListeners]) listener();
  }
}
