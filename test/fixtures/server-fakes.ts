// In-memory stand-ins for the hub's tests: a UiSession whose state the test sets, PeerLinks that record what the
// server sent, and a push notifier that records notifications.
import type { CloseCode, Device, Peer, PushSubscriptionJson, ServerMessage } from '../../src/protocol/messages.ts';
import { isParseError, parseServerMessage } from '../../src/protocol/parse.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';
import type { PeerLink, PushNotifier } from '../../src/server/link.ts';
import type { ChatFeed, ChatItem, ModelChoice, NoticeLevel, SessionStatus, UiSession, ViewLine } from '../../src/protocol/session.ts';
import { NotFound } from '../../src/protocol/errors.ts';

export class FakeFeed implements ChatFeed {
  list: ChatItem[];
  closed = false;
  private readonly listeners = new Set<() => void>();
  constructor(items: ChatItem[] = []) { this.list = items; }
  items(): readonly ChatItem[] { return this.list; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  set(items: ChatItem[]): void {
    this.list = items;
    for (const listener of this.listeners) listener();
  }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

export const STATUS: SessionStatus = { model: 'faux/faux-1', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0,
  memory: undefined, agents: [] };

export interface FakeSession extends UiSession {
  readonly root: FakeFeed;
  /** Agent feeds by lowercase name; `agentChat` returns these. */
  readonly agents: Map<string, FakeFeed>;
  readonly calls: string[];
  set(patch: Partial<SessionStatus>): void;
  emit(text: string, level: NoticeLevel): void;
}

export function fakeSession(items: ChatItem[] = []): FakeSession {
  let status = STATUS;
  const statusListeners = new Set<() => void>(), noticeListeners = new Set<(text: string, level: NoticeLevel) => void>();
  const calls: string[] = [], agents = new Map<string, FakeFeed>();
  const set = (patch: Partial<SessionStatus>): void => {
    status = { ...status, ...patch };
    for (const listener of statusListeners) listener();
  };
  const lines: ViewLine[] = [{ id: 0, n: 1, text: 'hello' }];
  const models: ModelChoice[] = [{ provider: 'faux', id: 'faux-1', name: 'Faux', available: true }];
  return {
    root: new FakeFeed(items), agents, calls, set,
    emit: (text, level) => { for (const listener of noticeListeners) listener(text, level); },
    get chat() { return this.root; },
    status: () => status,
    onStatus(listener) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    send(text, { requestId, steer, images } = {}) {
      calls.push(`send ${text} ${requestId ?? '-'}${steer ? ' steer' : ''}${images?.length ? ` images:${images.map(i => i.mimeType).join(',')}` : ''}`);
      return Promise.resolve();
    },
    abort() { calls.push('abort'); return Promise.resolve(); },
    stopAgents(name) { calls.push(`stop ${name ?? '*'}`); return Promise.resolve(name ? [name] : []); },
    // Agents in the status archive and restore; `Coder` is standing, and an unknown name is refused as the core does.
    archiveAgents(target) {
      calls.push(`archive ${'name' in target ? target.name : 'adhoc'}`);
      if ('name' in target && target.name === 'Coder') return Promise.reject(new Error('Coder is a standing agent; remove it from the roster first.'));
      const hit = status.agents.filter(agent => agent.archivedAt === undefined
        && ('name' in target ? agent.name.toLowerCase() === target.name.toLowerCase() : agent.role === 'main' && agent.name !== 'Coder'));
      if ('name' in target && !hit.length) return Promise.reject(new NotFound(`No agent named ${target.name}.`));
      const archivedAt = Date.now();
      set({ agents: status.agents.map(agent => hit.includes(agent) ? { ...agent, archivedAt } : agent) });
      return Promise.resolve(hit.map(agent => agent.name));
    },
    restoreAgent(name) {
      calls.push(`restore ${name}`);
      const hit = status.agents.find(agent => agent.name.toLowerCase() === name.toLowerCase());
      if (!hit) return Promise.reject(new NotFound(`No agent named ${name}.`));
      if (hit.archivedAt === undefined) return Promise.reject(new Error(`${hit.name} is not archived.`));
      set({ agents: status.agents.map(agent => agent === hit ? { name: agent.name, role: agent.role, parent: agent.parent, busy: agent.busy } : agent) });
      return Promise.resolve([hit.name]);
    },
    // Schedules in the status cancel; an unknown id is refused as the core does.
    cancelSchedule(id) {
      calls.push(`cancelSchedule ${id}`);
      const left = (status.schedules ?? []).filter(each => each.id !== id);
      if (left.length === (status.schedules ?? []).length) return Promise.reject(new NotFound(`No schedule #${id}.`));
      set({ schedules: left });
      return Promise.resolve();
    },
    agentChat(name) {
      calls.push(`agentChat ${name}`);
      return Promise.resolve(agents.get(name.toLowerCase()));
    },
    memoryView: () => Promise.resolve(lines),
    zoom(id, n) { return id === 0 ? Promise.resolve(`zoom ${id}+${n}`) : Promise.reject(new NotFound(`No line ${id}+${n}.`)); },
    models: () => Promise.resolve(models),
    setModel(provider, id) {
      return provider === 'faux' ? Promise.resolve() : Promise.reject(new Error(`Unknown model ${provider}/${id}`));
    },
    setTools(enabled) { calls.push(`tools ${enabled}`); set({ toolsEnabled: enabled }); return Promise.resolve(); },
    thinkingLevels: () => Promise.resolve(['low', 'medium', 'high']),
    setThinkingLevel(level) {
      if (level === 'max') return Promise.reject(new Error('faux/faux-1 takes low, medium, high; not max.'));
      calls.push(`thinking ${level}`);
      set({ thinkingLevel: level });
      return Promise.resolve();
    },
    onNotice(listener) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
  };
}

export interface FakeLink extends PeerLink {
  /** Every message the server sent, parsed. */
  readonly got: ServerMessage[];
  closedWith: { code: CloseCode; reason: string } | undefined;
  /** What `buffered()` reports. */
  pending: number;
  /** Delivers a client message (an object, serialized, or raw text). */
  deliver(message: object | string): void;
  /** The client goes away. */
  drop(): void;
  hello(visible?: boolean): void;
}

export function fakeLink(peer: Peer = 'socket', device?: Device): FakeLink {
  let onMessage: ((text: string) => void) | undefined, onClose: (() => void) | undefined;
  let gone = false;
  const link: FakeLink = {
    peer, who: peer === 'socket' ? 'socket' : `me@example.com/${device?.name ?? '?'}`,
    ...device ? { device } : {},
    got: [], closedWith: undefined, pending: 0,
    send(text) {
      if (gone) throw new Error('send after close');
      const message = parseServerMessage(text);
      if (isParseError(message)) throw new Error(`server sent an invalid message: ${message.message}: ${text}`);
      link.got.push(message);
    },
    buffered: () => link.pending,
    close(code, reason) {
      if (gone) return;
      link.send(JSON.stringify({ t: 'bye', code, reason }));
      link.closedWith = { code, reason };
      link.drop();
    },
    onMessage(listener) { onMessage = listener; },
    onClose(listener) { onClose = listener; },
    deliver(message) { onMessage?.(typeof message === 'string' ? message : JSON.stringify(message)); },
    drop() {
      if (gone) return;
      gone = true;
      onClose?.();
    },
    hello(visible = false) { link.deliver({ t: 'hello', protocol: PROTOCOL, client: 'test', visible }); },
  };
  return link;
}

export interface FakePush extends PushNotifier {
  readonly sent: { title: string; body: string; tag: string }[];
  readonly subscribed: string[];
}

export function fakePush(): FakePush {
  const sent: { title: string; body: string; tag: string }[] = [], subscribed: string[] = [];
  return {
    publicKey: 'BKEY', sent, subscribed,
    subscribe(subscription: PushSubscriptionJson, device: string | undefined) {
      subscribed.push(`${subscription.endpoint} ${device ?? '-'}`);
      return Promise.resolve();
    },
    unsubscribe(endpoint: string) { subscribed.push(`-${endpoint}`); return Promise.resolve(); },
    notify(message) { sent.push({ ...message }); return Promise.resolve(); },
  };
}
