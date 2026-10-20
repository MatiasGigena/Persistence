// The hub (ADR 0016): fans one UiSession out to every connected peer. It holds the connections, opens agent feeds
// once however many peers watch them, serves the ops, applies the remote tools policy (ADRs 0019, 0025), and tells the
// push notifier when Pi finishes or an agent reports while no one is looking.
import { CloseCode, ENABLE_TOOLS, ErrorCode, ROOT_FEED } from '../protocol/messages.ts';
import type { ChatItem, Device, NoticeLevel, SessionStatus, ToolsPolicy, Welcome } from '../protocol/messages.ts';
import { PROTOCOL } from '../protocol/version.ts';
import type { ChatFeed, UiSession } from '../ui/types.ts';
import { Connection, OpError } from './connection.ts';
import type { ConnectionHost, Handlers } from './connection.ts';
import type { DeviceRegistry, PeerHub, PeerLink, PushNotifier } from './link.ts';
import { InvalidSubscription } from './push.ts';

/** No push while some client was visible this recently. */
export const VISIBLE_MS = 60_000;
/** At most one push per tag this often. */
export const PUSH_EVERY_MS = 30_000;
/** Push bodies (with PI_DURABLE_PUSH_PREVIEW=on) are cut to this many characters. */
export const PREVIEW_CHARS = 140;

/** What the hub is told at start; the session comes later, with `start()`. */
export interface HubOptions {
  /** The server's version, for `welcome.server`. */
  readonly server: string;
  /** Changes on every start, for `welcome.boot`. */
  readonly boot: string;
  /** A hash of the web app's files, for `welcome.assets`. */
  readonly assets: string;
  /** The directory the coding tools work in. */
  readonly cwd: string;
  readonly tools: ToolsPolicy;
  /** Push bodies carry the reply's first words. */
  readonly pushPreview: boolean;
  readonly push?: PushNotifier;
  readonly devices?: DeviceRegistry;
  /** After `admin.revoke` forgot a device: drop what else it left (its push subscriptions). */
  readonly revoked?: (name: string) => Promise<unknown>;
  /** `admin.backup`: an online backup into `out` (absolute), or the default directory. */
  readonly backup?: (out: string | undefined) => Promise<{ readonly path: string; readonly bytes: number }>;
  /** One line for the server's log (the systemd journal). */
  readonly log: (line: string) => void;
}

interface AgentFeed {
  readonly id: string;
  readonly key: string;
  readonly feed: ChatFeed;
  readonly watchers: Set<Connection>;
  readonly unsubscribe: () => void;
  /** The agent has been in the status's list since the feed opened; leaving it then ends the feed. */
  seen: boolean;
  ended: boolean;
}

const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
};
const reportIds = (items: readonly ChatItem[]): Set<string> => new Set(items.filter(item => item.kind === 'report').map(item => item.id));
/** Who made a change, as the other clients' notices say it: the web device, or "terminal". */
const whoOf = (link: PeerLink): string => link.peer === 'socket' ? 'terminal' : link.device?.name ?? link.who;
const running = (status: SessionStatus): boolean => status.busy || status.agents.some(agent => agent.busy);

/** The server's PeerHub. Transports `attach` links; `start` brings the session; `close` ends every connection. */
export class Hub implements PeerHub {
  private readonly options: HubOptions;
  private readonly connections = new Set<Connection>();
  private readonly agentFeeds = new Map<string, AgentFeed>();
  private readonly opening = new Map<string, Promise<AgentFeed | undefined>>();
  private session: UiSession | undefined;
  private current: SessionStatus | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  private stopping = false;
  /** When a client was last visible (a visible one closing, or turning invisible). */
  private visibleAt = -Infinity;
  private readonly pushedAt = new Map<string, number>();
  private reports = new Set<string>();
  private idleSince: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly host: ConnectionHost;

  constructor(options: HubOptions) {
    this.options = options;
    this.host = {
      handlers: this.handlers(),
      welcome: link => this.welcome(link),
      status: () => this.current,
      root: () => this.session?.chat,
      visibility: connection => { if (!connection.visible) this.visibleAt = Math.max(this.visibleAt, connection.visibleAt); },
      closed: connection => this.closed(connection),
    };
  }

  attach(link: PeerLink): void {
    if (this.stopping) { link.close(CloseCode.restart, 'The server is shutting down'); return; }
    this.connections.add(new Connection(link, this.host));
  }

  closeDevice(name: string, code: CloseCode, reason: string): void {
    for (const connection of [...this.connections]) if (connection.link.device?.name === name) connection.close(code, reason);
  }

  /** The session is up: welcomed peers get the initial state and `ready`; later peers get it after `hello`. */
  start(session: UiSession): void {
    if (this.session || this.stopping) return;
    this.session = session;
    this.current = session.status();
    this.reports = reportIds(session.chat.items());
    this.unsubscribe.push(
      session.onStatus(() => this.statusChanged()),
      session.chat.subscribe(() => this.rootChanged()),
      session.onNotice((text, level) => this.broadcast(text, level)),
    );
    for (const connection of this.connections) connection.start();
    this.watchIdle();
  }

  /** A notice to every ready peer. */
  broadcast(text: string, level: NoticeLevel): void {
    for (const connection of this.connections) connection.notice(text, level);
  }

  /** Ends every connection with `bye {code}` and refuses new ones and new requests. Leaves the session open. */
  async close(code: CloseCode, reason: string): Promise<void> {
    this.stopping = true;
    clearTimeout(this.idleTimer);
    for (const off of this.unsubscribe.splice(0)) off();
    for (const connection of [...this.connections]) connection.close(code, reason);
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.agentFeeds.values()].map(entry => this.endFeed(entry)));
  }

  /** Some client is visible now, or was within VISIBLE_MS. */
  private seen(): boolean {
    if ([...this.connections].some(connection => connection.visible)) return true;
    return Date.now() - this.visibleAt < VISIBLE_MS;
  }

  private welcome(link: PeerLink): Omit<Welcome, 't'> {
    const { server, boot, assets, cwd, tools, push } = this.options;
    const web = link.peer === 'web';
    return { protocol: PROTOCOL, server, boot, assets, peer: link.peer, cwd, tools,
      ...web && push ? { pushKey: push.publicKey } : {}, ...web && link.device ? { device: link.device.name } : {} };
  }

  private closed(connection: Connection): void {
    this.connections.delete(connection);
    this.visibleAt = Math.max(this.visibleAt, connection.visibleAt);
    for (const entry of [...this.agentFeeds.values()]) this.release(entry, connection);
  }

  private need(): UiSession {
    if (this.stopping) throw new OpError(ErrorCode.unavailable, 'The server is shutting down.');
    if (!this.session) throw new OpError(ErrorCode.unavailable, 'The server is starting; try again in a moment.');
    return this.session;
  }

  // ---------------------------------------------------------------------------------------------- status and feeds

  private statusChanged(): void {
    const session = this.session;
    if (!session) return;
    const before = this.current, status = this.current = session.status();
    for (const connection of this.connections) connection.statusChanged();
    if (before?.busy && !status.busy) this.piFinished(session);
    for (const entry of [...this.agentFeeds.values()]) {
      const present = status.agents.some(agent => agent.name.toLowerCase() === entry.key);
      if (present) entry.seen = true;
      else if (entry.seen) void this.endFeed(entry, 'The agent is gone.');
    }
    this.watchIdle();
  }

  private rootChanged(): void {
    const session = this.session;
    if (!session) return;
    for (const connection of this.connections) connection.feedChanged(ROOT_FEED);
    const items = session.chat.items(), before = this.reports;
    this.reports = reportIds(items);
    for (const item of items) {
      if (item.kind !== 'report' || before.has(item.id)) continue;
      this.notify(`[${item.from}]`, item.text, `agent-${item.from}`);
    }
  }

  /** Opens (or shares) the agent's feed for `connection`; its id, or undefined for no such agent. */
  private async openFeed(connection: Connection, name: string): Promise<string | undefined> {
    const session = this.need(), key = name.toLowerCase();
    let entry = this.agentFeeds.get(key);
    if (!entry) {
      let opening = this.opening.get(key);
      if (!opening) {
        opening = this.startFeed(session, key).finally(() => this.opening.delete(key));
        this.opening.set(key, opening);
      }
      entry = await opening;
    }
    if (!entry) return undefined;
    if (connection.isClosed || entry.ended) {
      if (!entry.watchers.size) void this.endFeed(entry);
      if (connection.isClosed) throw new OpError(ErrorCode.unavailable, 'The connection closed.');
      return this.openFeed(connection, name);
    }
    entry.watchers.add(connection);
    connection.addFeed(entry.id, entry.feed);
    return entry.id;
  }

  private async startFeed(session: UiSession, key: string): Promise<AgentFeed | undefined> {
    const feed = await session.agentChat(key);
    if (!feed) return undefined;
    const id = `agent:${key}`;
    const watchers = new Set<Connection>();
    const unsubscribe = feed.subscribe(() => { for (const connection of watchers) connection.feedChanged(id); });
    const seen = this.current?.agents.some(agent => agent.name.toLowerCase() === key) ?? false;
    const entry: AgentFeed = { id, key, feed, watchers, unsubscribe, seen, ended: false };
    if (this.stopping) { await this.endFeed(entry); return undefined; }
    this.agentFeeds.set(key, entry);
    return entry;
  }

  /** `connection` stops watching the feed; the last one out closes it. */
  private release(entry: AgentFeed, connection: Connection): void {
    if (!entry.watchers.delete(connection)) return;
    connection.removeFeed(entry.id);
    if (!entry.watchers.size) void this.endFeed(entry);
  }

  /** Closes the feed; with `reason`, its watchers get `feed.end`. */
  private async endFeed(entry: AgentFeed, reason?: string): Promise<void> {
    if (entry.ended) return;
    entry.ended = true;
    if (this.agentFeeds.get(entry.key) === entry) this.agentFeeds.delete(entry.key);
    entry.unsubscribe();
    for (const connection of entry.watchers) connection.removeFeed(entry.id, reason);
    entry.watchers.clear();
    try { await entry.feed.close(); } catch (error) {
      this.options.log(`closing the feed of ${entry.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private feedOf(connection: Connection, feed: string): void {
    if (!connection.hasFeed(feed)) throw new OpError(ErrorCode.notFound, `No open feed ${feed}.`);
  }

  // ---------------------------------------------------------------------------------------------- tools policy

  /** Arms the idle timer while the tools are on and nothing runs; a run, or the tools going off, disarms it. */
  private watchIdle(): void {
    const status = this.current;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const minutes = this.options.tools.idleMinutes;
    if (minutes === undefined || !status?.toolsEnabled || this.stopping) { this.idleSince = undefined; return; }
    if (running(status)) { this.idleSince = undefined; return; }
    this.idleSince ??= Date.now();
    const wait = this.idleSince + minutes * 60_000 - Date.now();
    this.idleTimer = setTimeout(() => void this.idleOff(), Math.max(0, wait));
  }

  private async idleOff(): Promise<void> {
    const session = this.session, status = this.current;
    if (!session || !status?.toolsEnabled || running(status) || this.stopping) return;
    const minutes = this.options.tools.idleMinutes ?? 0;
    try {
      await session.setTools(false);
    } catch (error) {
      this.options.log(`turning idle coding tools off failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.idleSince = undefined;
    this.options.log(`coding tools off: idle for ${minutes} minutes`);
    this.broadcast(`Coding tools off after ${minutes} idle minutes.`, 'info');
  }

  private async setTools(connection: Connection, enabled: boolean, confirm: typeof ENABLE_TOOLS | undefined): Promise<null> {
    const session = this.need(), { link } = connection;
    if (enabled && link.peer === 'web' && this.options.tools.remote === 'off') {
      throw new OpError(ErrorCode.forbidden, 'Coding tools can be turned on only from a terminal on the server (PI_DURABLE_REMOTE_TOOLS=off).');
    }
    if (enabled && confirm !== ENABLE_TOOLS) throw new OpError(ErrorCode.badRequest, `Turning tools on needs confirm: '${ENABLE_TOOLS}'.`);
    const was = session.status().toolsEnabled;
    try { await session.setTools(enabled); } catch (error) {
      throw new OpError(ErrorCode.failed, error instanceof Error ? error.message : String(error));
    }
    if (enabled) this.idleSince = Date.now();
    this.current = session.status();
    this.watchIdle();
    if (was === enabled) return null;
    const who = whoOf(link);
    this.options.log(`coding tools ${enabled ? 'on' : 'off'}, by ${link.who} (${link.peer})`);
    this.broadcast(`Coding tools ${enabled ? 'on' : 'off'}, by ${who}.`, enabled ? 'warn' : 'info');
    return null;
  }

  // ---------------------------------------------------------------------------------------------- push

  private piFinished(session: UiSession): void {
    const last = session.chat.items().findLast(item => item.kind === 'assistant');
    this.notify('Pi finished', last?.kind === 'assistant' ? last.text : '', 'pi');
  }

  /** A push, unless a client was visible within VISIBLE_MS or this tag was pushed within PUSH_EVERY_MS. */
  private notify(title: string, text: string, tag: string): void {
    const { push, pushPreview } = this.options;
    if (!push || this.stopping || this.seen()) return;
    const now = Date.now(), last = this.pushedAt.get(tag);
    if (last !== undefined && now - last < PUSH_EVERY_MS) return;
    this.pushedAt.set(tag, now);
    push.notify({ title, body: pushPreview ? snippet(text) : '', tag }).catch(() => { /* notify logs its own failures */ });
  }

  // ---------------------------------------------------------------------------------------------- ops

  private handlers(): Handlers {
    const registry = (): DeviceRegistry => {
      if (this.stopping) throw new OpError(ErrorCode.unavailable, 'The server is shutting down.');
      if (!this.options.devices) throw new OpError(ErrorCode.unavailable, 'Web devices are not available on this server.');
      return this.options.devices;
    };
    const notifier = (): PushNotifier => {
      if (this.stopping) throw new OpError(ErrorCode.unavailable, 'The server is shutting down.');
      if (!this.options.push) throw new OpError(ErrorCode.unavailable, 'Push notifications are not set up on this server.');
      return this.options.push;
    };
    const failed = (error: unknown): OpError => error instanceof OpError ? error
      : new OpError(ErrorCode.failed, error instanceof Error ? error.message : String(error));
    return {
      send: async ({ text, requestId }) => {
        if (!text.trim()) throw new OpError(ErrorCode.badRequest, 'The message is empty.');
        if (requestId !== undefined && (requestId.length < 1 || requestId.length > 128)) {
          throw new OpError(ErrorCode.badRequest, 'requestId must be 1 to 128 characters.');
        }
        try { await this.need().send(text, requestId); } catch (error) { throw failed(error); }
        return null;
      },
      abort: async () => { await this.need().abort(); return null; },
      stopAgents: async ({ name }) => ({ names: await this.need().stopAgents(name) }),
      'feed.open': async ({ name }, connection) => {
        const feed = await this.openFeed(connection, name);
        if (feed === undefined) throw new OpError(ErrorCode.notFound, `No agent named ${name}.`);
        return { feed };
      },
      'feed.close': ({ feed }, connection) => {
        if (feed === ROOT_FEED) throw new OpError(ErrorCode.badRequest, 'Pi\'s feed cannot be closed.');
        this.feedOf(connection, feed);
        const entry = [...this.agentFeeds.values()].find(each => each.id === feed);
        if (entry) this.release(entry, connection);
        else connection.removeFeed(feed);
        return Promise.resolve(null);
      },
      'feed.resync': ({ feed }, connection) => {
        this.feedOf(connection, feed);
        connection.resync(feed);
        return Promise.resolve(null);
      },
      'memory.view': async () => ({ lines: await this.need().memoryView() }),
      'memory.zoom': async ({ id, n }) => {
        const session = this.need();
        try { return { text: await session.zoom(id, n) }; } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new OpError(/^Memory is not open/.test(message) ? ErrorCode.unavailable : ErrorCode.notFound, message);
        }
      },
      models: async () => ({ models: await this.need().models() }),
      'model.set': async ({ provider, id }) => {
        const session = this.need();
        try { await session.setModel(provider, id); } catch (error) { throw failed(error); }
        return null;
      },
      'tools.set': ({ enabled, confirm }, connection) => this.setTools(connection, enabled, confirm),
      'thinking.levels': async () => ({ levels: await this.need().thinkingLevels() }),
      'thinking.set': async ({ level }) => {
        try { await this.need().setThinkingLevel(level); } catch (error) { throw failed(error); }
        return null;
      },
      'push.subscribe': async ({ subscription }, connection) => {
        let url: URL | undefined;
        try { url = new URL(subscription.endpoint); } catch { url = undefined; }
        if (url?.protocol !== 'https:') throw new OpError(ErrorCode.badRequest, 'endpoint must be an https: URL.');
        try { await notifier().subscribe(subscription, connection.link.device?.name); } catch (error) {
          throw error instanceof InvalidSubscription ? new OpError(ErrorCode.badRequest, error.message) : failed(error);
        }
        return null;
      },
      'push.unsubscribe': async ({ endpoint }) => {
        try { await notifier().unsubscribe(endpoint); } catch (error) { throw failed(error); }
        return null;
      },
      'admin.backup': async ({ out }) => {
        if (out !== undefined && !out.startsWith('/')) throw new OpError(ErrorCode.badRequest, 'out must be an absolute path.');
        if (this.stopping) throw new OpError(ErrorCode.unavailable, 'The server is shutting down.');
        if (!this.options.backup) throw new OpError(ErrorCode.unavailable, 'Backups are not available on this server.');
        try { return await this.options.backup(out); } catch (error) { throw failed(error); }
      },
      'admin.pair': async () => {
        try { return await registry().pair(); } catch (error) { throw failed(error); }
      },
      'admin.devices': async () => {
        let devices: readonly Device[];
        try { devices = await registry().list(); } catch (error) { throw failed(error); }
        return { devices };
      },
      'admin.revoke': async ({ name }) => {
        let found: boolean;
        try { found = await registry().revoke(name); } catch (error) { throw failed(error); }
        if (!found) throw new OpError(ErrorCode.notFound, `No device named ${name}.`);
        this.closeDevice(name, CloseCode.unauthorized, 'This device was revoked.');
        this.options.log(`device "${name}" revoked`);
        try { await this.options.revoked?.(name); } catch (error) {
          this.options.log(`after revoking "${name}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      },
    };
  }
}
