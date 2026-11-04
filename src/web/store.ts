// The web app's state: the root feed's mirror, open agent feeds, the status, local notices, and messages sent but
// not yet in the feed. No DOM: `handle` folds one server message in and returns what the caller must do about it
// (ask for a resync, reload), so the whole sync logic runs in Node tests.
import { ROOT_FEED } from '../protocol/messages.ts';
import type { ItemOp, ServerMessage, Welcome } from '../protocol/messages.ts';
import type { ChatItem, NoticeLevel, SessionStatus } from '../protocol/session.ts';
import type { ChatImage } from '../protocol/images.ts';
import { applyOps } from '../protocol/mirror.ts';

/** A message sent from this client: `sending` until the server admits it, then `queued` until it shows in the feed. */
export interface PendingItem {
  readonly kind: 'pending';
  readonly id: string;
  readonly text: string;
  readonly state: 'sending' | 'queued';
  /** Sent to steer Pi's running work rather than to follow it up. */
  readonly steer?: boolean;
  /** Images sent with the text (ADR 0031). */
  readonly images?: readonly ChatImage[];
}

/** What a chat view draws: the feed's items, local notices among them, and pending sends at the end. */
export type ViewItem = ChatItem | PendingItem;

/**
 * The assistant messages that end a turn: in each stretch between the user's messages (a
 * pending one too, so a steer sent mid-run splits the turn), the last one with text that is not streaming. Each gets
 * the turn's actions (copy). An assistant message with no text (tool calls only, or cut off by a stop) leaves the
 * end where it was; a streaming one clears it until it finishes.
 */
export function turnEnds(items: readonly ViewItem[]): Set<string> {
  const ends = new Set<string>();
  let last: string | undefined;
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'pending') {
      if (last) ends.add(last);
      last = undefined;
    } else if (item.kind === 'assistant') {
      if (item.streaming) last = undefined;
      else if (item.text.trim()) last = item.id;
    }
  }
  if (last) ends.add(last);
  return ends;
}

/**
 * The warnings and errors among `items` to read out to a screen reader: each notice not in `seen`, as "Error: …" or
 * "Warning: …". Every notice's id goes into `seen`, so each is read once and info notices never.
 */
export function freshAlerts(items: readonly ViewItem[], seen: Set<string>): string[] {
  const alerts: string[] = [];
  for (const item of items) {
    if (item.kind !== 'notice' || seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.level !== 'info') alerts.push(`${item.level === 'error' ? 'Error' : 'Warning'}: ${item.text}`);
  }
  return alerts;
}

/** A feed's mirror. `waiting`: an op did not fit; `items` messages are ignored until the next snapshot. */
export interface Mirror {
  readonly items: readonly ChatItem[];
  readonly waiting: boolean;
}

/** An agent feed this client opened: its name (to reopen it after a reconnect), mirror, and end. */
export interface AgentFeed {
  readonly name: string;
  readonly mirror: Mirror;
  /** A snapshot has come (now or before a reconnect): `mirror` is the conversation, not yet a placeholder. */
  readonly loaded: boolean;
  readonly ended?: string;
}

/** What the caller must do after `handle`. */
export type Effect =
  | { readonly t: 'resync'; readonly feed: string }
  | { readonly t: 'reload' }
  | { readonly t: 'ready' }
  | { readonly t: 'reply'; readonly text: string; readonly from: string }
  | { readonly t: 'bye'; readonly code: number; readonly reason: string };

interface LocalNotice { readonly item: ChatItem & { kind: 'notice' }; readonly after: string | undefined }
interface Pending { readonly item: PendingItem; readonly baseline: ReadonlySet<string> }

const EMPTY: Mirror = { items: [], waiting: false };

/** One mirror after a `snapshot` or `items` message, and whether it needs a resync. */
function step(mirror: Mirror, msg: { t: 'snapshot'; items: readonly ChatItem[] } | { t: 'items'; ops: readonly ItemOp[] }): { mirror: Mirror; resync: boolean } {
  if (msg.t === 'snapshot') return { mirror: { items: msg.items, waiting: false }, resync: false };
  if (mirror.waiting) return { mirror, resync: false };
  const next = applyOps(mirror.items, msg.ops);
  return next === 'resync' ? { mirror: { items: mirror.items, waiting: true }, resync: true } : { mirror: { items: next, waiting: false }, resync: false };
}

/** Assistant items that finished streaming between two lists: new replies to announce. */
function finished(before: readonly ChatItem[], after: readonly ChatItem[]): string[] {
  const was = new Map(before.map(item => [item.id, item]));
  return after.flatMap(item => {
    if (item.kind !== 'assistant' || item.streaming || !item.text.trim()) return [];
    const old = was.get(item.id);
    return old?.kind === 'assistant' && old.streaming ? [item.text] : old ? [] : [item.text];
  });
}

export class Store {
  welcome: Welcome | undefined;
  status: SessionStatus | undefined;
  root: Mirror = EMPTY;
  /** Agent feeds by feed id. */
  readonly agents = new Map<string, AgentFeed>();
  /** Agent feeds open before the link dropped, by name, until opened again. */
  private readonly detached = new Map<string, AgentFeed>();
  /** Agent feed messages that arrived before `openAgent` named the feed. */
  private readonly orphans = new Map<string, Mirror>();
  /** Set once the first `ready` arrived; reply announcements start after it, not for the backlog. */
  private synced = false;
  private assets: string | undefined;
  private boot: string | undefined;
  private notices: LocalNotice[] = [];
  private pending: Pending[] = [];
  private noticeCount = 0;
  private readonly listeners = new Set<() => void>();

  /** Called after any change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Folds one server message in. `res` and `pong` belong to the link and are ignored here. */
  handle(msg: ServerMessage): Effect[] {
    const effects: Effect[] = [];
    switch (msg.t) {
      case 'welcome': {
        // A new `assets` hash means new app files: reload. A new `boot` alone is a restart with the same files.
        if (this.assets !== undefined && msg.assets !== this.assets) effects.push({ t: 'reload' });
        else if (this.boot !== undefined && msg.boot !== this.boot) this.notice('The server restarted.');
        this.assets = msg.assets;
        this.boot = msg.boot;
        this.welcome = msg;
        this.synced = false;
        break;
      }
      case 'ready':
        this.synced = true;
        effects.push({ t: 'ready' });
        break;
      case 'status': {
        const was = this.status;
        this.status = msg.status;
        // A run ended with nothing queued: anything still pending was withdrawn (stop) or is already shown.
        if (was?.busy && !msg.status.busy && msg.status.queued === 0) this.pending = this.pending.filter(p => p.item.state === 'sending');
        break;
      }
      case 'snapshot': case 'items': {
        const root = msg.feed === ROOT_FEED;
        const agent = this.agents.get(msg.feed);
        if (!root && !agent) {
          // A feed's snapshot can beat the `feed.open` answer's handler: keep it for `openAgent`.
          const orphan = this.orphans.get(msg.feed);
          if (msg.t === 'snapshot' || orphan) this.orphans.set(msg.feed, step(orphan ?? EMPTY, msg).mirror);
          return effects;
        }
        const before = root ? this.root : agent?.mirror ?? EMPTY;
        const { mirror, resync } = step(before, msg);
        if (resync) effects.push({ t: 'resync', feed: msg.feed });
        if (root) {
          this.root = mirror;
          this.settlePending();
          if (this.synced) for (const text of finished(before.items, mirror.items)) effects.push({ t: 'reply', text, from: 'Pi' });
        } else if (agent) this.agents.set(msg.feed, { ...agent, mirror, loaded: agent.loaded || msg.t === 'snapshot' });
        break;
      }
      case 'feed.end': {
        const agent = this.agents.get(msg.feed);
        if (agent) this.agents.set(msg.feed, { ...agent, ended: msg.reason });
        break;
      }
      case 'notice':
        this.notice(msg.text, msg.level);
        return effects;
      case 'bye':
        effects.push({ t: 'bye', code: msg.code, reason: msg.reason });
        return effects;
      case 'res': case 'pong':
        return effects;
    }
    this.changed();
    return effects;
  }

  /**
   * A `feed.resync` the server refused: the feed takes items again (the next gap asks anew) instead of waiting for a
   * snapshot that is not coming, and the failure is shown.
   */
  resyncFailed(feed: string, why: string): void {
    const unfreeze = (mirror: Mirror): Mirror => ({ ...mirror, waiting: false });
    if (feed === ROOT_FEED) this.root = unfreeze(this.root);
    const agent = this.agents.get(feed);
    if (agent) this.agents.set(feed, { ...agent, mirror: unfreeze(agent.mirror) });
    this.notice(`Could not resync the chat: ${why}`, 'error');
  }

  /** Shows text in the root chat after its current last item, as the terminal's local notices. */
  notice(text: string, level: NoticeLevel = 'info'): void {
    const item = { kind: 'notice', id: `web:${++this.noticeCount}`, text, level } as const;
    this.notices.push({ item, after: this.root.items.at(-1)?.id });
    this.changed();
  }

  /** The root chat: items, local notices after the item they followed, then pending sends. */
  rootView(): ViewItem[] {
    const byAfter = new Map<string | undefined, ChatItem[]>();
    for (const { item, after } of this.notices) byAfter.set(after, [...byAfter.get(after) ?? [], item]);
    const live = new Set(this.root.items.map(item => item.id));
    const view: ViewItem[] = [...byAfter.get(undefined) ?? []];
    for (const item of this.root.items) view.push(item, ...byAfter.get(item.id) ?? []);
    // A notice whose item left the feed moves to the end rather than vanishing.
    for (const [after, items] of byAfter) if (after !== undefined && !live.has(after)) view.push(...items);
    view.push(...this.pending.map(p => p.item));
    return view;
  }

  /** Adds a message being sent, shown at the end of the chat until it is in the feed. */
  addPending(id: string, text: string, steer = false, images: readonly ChatImage[] = []): void {
    const baseline = new Set(this.root.items.filter(item => item.kind === 'user').map(item => item.id));
    const item: PendingItem = { kind: 'pending', id, text, state: 'sending' };
    const marked = steer ? { ...item, steer } : item;
    this.pending.push({ item: images.length ? { ...marked, images } : marked, baseline });
    this.changed();
  }

  /** The server admitted the send `id`: it waits in the queue until the feed shows it. */
  admitPending(id: string): void {
    this.pending = this.pending.map(p => (p.item.id === id ? { ...p, item: { ...p.item, state: 'queued' } } : p));
    this.settlePending();
    this.changed();
  }

  /** The send `id` failed for good: it leaves the chat. */
  dropPending(id: string): void {
    this.pending = this.pending.filter(p => p.item.id !== id);
    this.changed();
  }

  /**
   * Drops admitted pending sends whose text (and number of images) now shows as a user item that was not there when
   * they were sent.
   */
  private settlePending(): void {
    if (!this.pending.length) return;
    const used = new Set<string>();
    this.pending = this.pending.filter(p => {
      if (p.item.state !== 'queued') return true;
      const match = this.root.items.find(item => item.kind === 'user' && !p.baseline.has(item.id) && !used.has(item.id)
        && item.text === p.item.text && (item.images?.length ?? 0) === (p.item.images?.length ?? 0));
      if (!match) return true;
      used.add(match.id);
      return false;
    });
  }

  /** Tracks an agent feed opened with `feed.open`; a snapshot follows. Its last mirror, if any, shows meanwhile. */
  openAgent(feed: string, name: string): void {
    const last = this.agents.get(feed) ?? this.detached.get(name);
    this.detached.delete(name);
    const orphan = this.orphans.get(feed);
    this.agents.set(feed, { name, mirror: orphan ?? last?.mirror ?? EMPTY, loaded: orphan !== undefined || (last?.loaded ?? false) });
    this.orphans.delete(feed);
    this.changed();
  }

  /** Stops tracking an agent feed. */
  closeAgent(feed: string): void {
    const agent = this.agents.get(feed);
    if (agent) this.detached.delete(agent.name);
    this.orphans.delete(feed);
    if (this.agents.delete(feed)) this.changed();
  }

  /** The agent feed open under `name`: its id (undefined while detached by a reconnect) and state. */
  agentByName(name: string): { readonly feed: string | undefined; readonly agent: AgentFeed } | undefined {
    for (const [feed, agent] of this.agents) if (agent.name === name) return { feed, agent };
    const agent = this.detached.get(name);
    return agent && { feed: undefined, agent };
  }

  /**
   * The link dropped: agent feed ids do not survive it. The feeds are kept by name, showing their last state, and
   * the names returned are those to open again after `ready`.
   */
  disconnect(): string[] {
    for (const agent of this.agents.values()) if (agent.ended === undefined) this.detached.set(agent.name, agent);
    this.agents.clear();
    this.orphans.clear();
    this.changed();
    return [...this.detached.keys()];
  }

  /** Forgets a detached agent feed (its sheet closed while offline). */
  forget(name: string): void {
    if (this.detached.delete(name)) this.changed();
  }
}
