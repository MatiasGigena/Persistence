// FakeServer: an in-memory `pi-durable serve`, written from docs/protocol.md alone, for client tests and as a
// conformance fixture. It knows no transport: a test (or a transport adapter) connects a peer with a `send`
// callback that receives every server message as JSON text, in order, and hands the peer each client message with
// `peer.handle(text)`, which also returns the messages it sent while handling it.
//
//   const server = new FakeServer({ items: [{ kind: 'user', id: 'u1', text: 'hi' }] });
//   const peer = server.connect({ send: text => wire.push(text), end: () => wire.close() });
//   peer.handle(JSON.stringify({ t: 'hello', protocol: PROTOCOL, client: 'test', visible: true })); // initial state
//
// The host's side is plain state that tests change: `setItems`, `setAgentItems`, `removeAgent`, `setStatus`,
// `notice`. Every change goes to every ready peer at once, as `items` ops (diff.ts `diffItems`, or a snapshot)
// or a `status`; there is no flush timer and no backpressure. What clients asked is recorded: `requests`, the
// admitted `sends` (deduplicated by requestId, as pi-durable does), `aborts`, `visible`. `hold(op)` keeps that
// op's answers back until `release(op)` (an admitted `send` stays admitted), and `restart()` ends every peer with
// `bye 1012` and a new boot, as a server restart does. `peer.push(message)` sends anything, e.g. an op that
// does not fit, to test resync. Web peers (`connect({ peer: 'web' })`) get `forbidden` for admin ops, socket peers
// for push ops; `tools.remote` 'off' forbids web peers to enable tools.
import { CloseCode, ENABLE_TOOLS, ROOT_FEED, SOCKET_ONLY, WEB_ONLY } from '../../src/protocol/messages.ts';
import type { Device, ErrorCode, Op, Peer, PushSubscriptionJson, Request, ServerMessage, ToolsPolicy } from '../../src/protocol/messages.ts';
import type { ChatItem, ModelChoice, NoticeLevel, SessionStatus, ViewLine } from '../../src/protocol/session.ts';
import { diffItems, wireItem } from '../../src/protocol/diff.ts';
import { isParseError, parseClientMessage, parseServerMessage } from '../../src/protocol/parse.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';

export const FAKE_STATUS: SessionStatus = {
  model: 'faux/model-1', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0,
  memory: { messages: 2, unsummarized: 0, active: 0, failed: 0, lastError: undefined, viewBytes: 40, viewLines: 2 },
  agents: [],
};

export const FAKE_MODELS: readonly ModelChoice[] = [
  { provider: 'faux', id: 'model-1', name: 'Faux One', available: true },
  { provider: 'faux', id: 'model-2', name: 'Faux Two', available: true },
  { provider: 'locked', id: 'model-3', name: 'Locked', available: false, note: 'needs a key' },
];

export interface FakeServerOptions {
  readonly items?: readonly ChatItem[];
  readonly status?: SessionStatus;
  /** Agents and their conversations, by name. */
  readonly agents?: Readonly<Record<string, readonly ChatItem[]>>;
  readonly view?: readonly ViewLine[];
  readonly models?: readonly ModelChoice[];
  readonly tools?: ToolsPolicy;
  readonly cwd?: string;
}

/** What a transport gives a new peer: where its messages go, and how to end it. */
export interface FakeTransport {
  /** One server message, serialized. */
  readonly send: (text: string) => void;
  /** The server ended the connection (after a `bye`). */
  readonly end: () => void;
  readonly peer?: Peer;
  /** A web peer's device name. */
  readonly device?: string;
}

type Answer = { readonly result: unknown } | { readonly error: ErrorCode; readonly message: string };
const fail = (error: ErrorCode, message: string): Answer => ({ error, message });

/** One connected client. */
export class FakePeer {
  readonly peer: Peer;
  readonly device: string | undefined;
  /** False until `hello`, and after the connection ended. */
  ready = false;
  ended = false;
  visible = false;
  private readonly server: FakeServer;
  private readonly transport: FakeTransport;
  /** Per open feed, the items it was last sent: feed id → agent name (undefined for root) and items. */
  readonly feeds = new Map<string, { readonly agent: string | undefined; sent: readonly ChatItem[] }>();
  private lastStatus = '';
  private log: string[] | undefined;

  constructor(server: FakeServer, transport: FakeTransport) {
    this.server = server;
    this.transport = transport;
    this.peer = transport.peer ?? 'socket';
    this.device = transport.device;
  }

  /** Handles one client message; returns what was sent while handling it (each also went to `send`). */
  handle(text: string): ServerMessage[] {
    const log: string[] = [];
    this.log = log;
    try { this.receive(text); } finally { this.log = undefined; }
    // Read back with the client's parser: what this fixture sends must parse.
    return log.map(line => {
      const message = parseServerMessage(line);
      if (isParseError(message)) throw new Error(`FakeServer sent a malformed message (${message.message}): ${line}`);
      return message;
    });
  }

  /** Sends any message to this peer. */
  push(message: ServerMessage): void { this.write(JSON.stringify(message)); }

  private write(text: string): void {
    if (this.ended) return;
    this.log?.push(text);
    this.transport.send(text);
  }

  /** Ends the connection: `bye` with the code, then the transport's end. */
  close(code: number = CloseCode.normal, reason = 'closed'): void {
    if (this.ended) return;
    this.push({ t: 'bye', code, reason });
    this.drop();
  }

  /** Ends the connection without a `bye`, as a crash or a network drop would. */
  drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    this.server.forget(this);
    this.transport.end();
  }

  /** The client went away (its transport closed). */
  gone(): void {
    this.ended = true;
    this.ready = false;
    this.server.forget(this);
  }

  /** Sends what changed since the last sync: the status, then each open feed's ops or snapshot. */
  sync(): void {
    if (!this.ready) return;
    const status = JSON.stringify(this.server.status);
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.push({ t: 'status', status: this.server.status });
    }
    for (const [feed, state] of this.feeds) {
      const items = this.server.feedItems(state.agent);
      if (!items) {
        this.feeds.delete(feed);
        this.push({ t: 'feed.end', feed, reason: 'The agent is gone' });
        continue;
      }
      const wire = items.map(wireItem);
      const ops = diffItems(state.sent, wire);
      state.sent = wire;
      if (ops === 'snapshot') this.push({ t: 'snapshot', feed, items: wire });
      else if (ops.length) this.push({ t: 'items', feed, ops });
    }
  }

  /** A fresh snapshot of one feed. */
  snapshot(feed: string): void {
    const state = this.feeds.get(feed);
    const items = state && this.server.feedItems(state.agent);
    if (!state || !items) return;
    state.sent = items.map(wireItem);
    this.push({ t: 'snapshot', feed, items: state.sent });
  }

  private receive(text: string): void {
    if (this.ended) return;
    const message = parseClientMessage(text);
    if (isParseError(message)) {
      if (message.invalid === 'unknown_type') return;
      const code: ErrorCode = message.invalid === 'unknown_op' ? 'unknown_op' : 'bad_request';
      this.push({ t: 'res', id: message.id ?? -1, ok: false, error: { code, message: message.message } });
      return;
    }
    switch (message.t) {
      case 'hello':
        if (this.ready) return;
        if (message.protocol !== PROTOCOL) { this.close(CloseCode.version, `This server speaks protocol ${PROTOCOL}`); return; }
        this.visible = message.visible;
        this.push({
          t: 'welcome', protocol: PROTOCOL, server: '0.1.0', boot: this.server.boot, assets: 'fake', peer: this.peer,
          cwd: this.server.cwd, tools: this.server.tools, ...this.device === undefined ? {} : { device: this.device },
        });
        this.lastStatus = JSON.stringify(this.server.status);
        this.push({ t: 'status', status: this.server.status });
        this.feeds.set(ROOT_FEED, { agent: undefined, sent: [] });
        this.snapshot(ROOT_FEED);
        this.ready = true;
        this.push({ t: 'ready' });
        return;
      case 'visible': if (this.ready) this.visible = message.visible; return;
      case 'ping': if (this.ready) this.push({ t: 'pong', n: message.n }); return;
      case 'req':
        if (!this.ready) { this.push({ t: 'res', id: message.id, ok: false, error: { code: 'version', message: 'Say hello first' } }); return; }
        this.server.requests.push(message);
        this.server.answer(this, message);
    }
  }

  /** Answers a request now, or when its op is released. */
  respond(request: Request, answer: Answer, after?: () => void): void {
    const reply = (): void => {
      if (this.ended) return;
      if ('error' in answer) this.push({ t: 'res', id: request.id, ok: false, error: { code: answer.error, message: answer.message } });
      else this.write(JSON.stringify({ t: 'res', id: request.id, op: request.op, ok: true, result: answer.result }));
      after?.();
    };
    if (this.server.held.has(request.op)) this.server.queue.push({ op: request.op, reply });
    else reply();
  }

  /** Opens agent `name`'s feed; the same id when it is open already. */
  openFeed(name: string): string {
    for (const [feed, state] of this.feeds) if (state.agent === name) return feed;
    const feed = `agent:${name}:${this.server.nextFeed()}`;
    this.feeds.set(feed, { agent: name, sent: [] });
    return feed;
  }
}

/** An in-memory server; see the top of this file. */
export class FakeServer {
  status: SessionStatus;
  boot = 'boot-1';
  readonly cwd: string;
  tools: ToolsPolicy;
  readonly requests: Request[] = [];
  /** Admitted sends, deduplicated by requestId. */
  readonly sends: { readonly text: string; readonly requestId: string | undefined }[] = [];
  aborts = 0;
  readonly backups: (string | undefined)[] = [];
  readonly subscriptions = new Map<string, PushSubscriptionJson>();
  readonly devices: Device[] = [{ name: 'phone', pairedAt: 1 }];
  /** Machine connectors' registrations and grants, in the order they arrived (`machine.register`, `machine.set`). */
  readonly machines: { readonly op: 'machine.register' | 'machine.set'; readonly enabled: boolean }[] = [];
  readonly held = new Set<Op>();
  readonly queue: { readonly op: Op; readonly reply: () => void }[] = [];
  private items: readonly ChatItem[];
  private readonly agents: Map<string, readonly ChatItem[]>;
  private readonly view: readonly ViewLine[];
  private readonly models: readonly ModelChoice[];
  private readonly live = new Set<FakePeer>();
  private boots = 1;
  private userItems = 0;
  private feedCount = 0;

  constructor(options: FakeServerOptions = {}) {
    this.items = options.items ?? [];
    this.status = options.status ?? FAKE_STATUS;
    this.agents = new Map(Object.entries(options.agents ?? {}));
    this.view = options.view ?? [{ id: 0, n: 1, text: 'hello' }, { id: 1, n: 1, text: 'world' }];
    this.models = options.models ?? FAKE_MODELS;
    this.tools = options.tools ?? { remote: 'confirm', idleMinutes: 30 };
    this.cwd = options.cwd ?? '/fake/cwd';
    this.syncAgents();
  }

  connect(transport: FakeTransport): FakePeer {
    const peer = new FakePeer(this, transport);
    this.live.add(peer);
    return peer;
  }

  /** A number for a new feed id: ids differ across connections, as a real server's may. */
  nextFeed(): number { return ++this.feedCount; }

  /** Connected peers, in connection order. */
  peers(): FakePeer[] { return [...this.live]; }

  forget(peer: FakePeer): void { this.live.delete(peer); }

  /** Pi's items, or an agent's; undefined for an agent that does not exist. */
  feedItems(agent: string | undefined): readonly ChatItem[] | undefined {
    return agent === undefined ? this.items : this.agents.get(agent);
  }

  rootItems(): readonly ChatItem[] { return this.items; }

  setItems(items: readonly ChatItem[]): void { this.items = items; this.broadcast(); }

  setAgentItems(name: string, items: readonly ChatItem[]): void {
    this.agents.set(name, items);
    this.syncAgents();
    this.broadcast();
  }

  removeAgent(name: string): void {
    this.agents.delete(name);
    this.syncAgents();
    this.broadcast();
  }

  setStatus(change: Partial<SessionStatus>): void { this.status = { ...this.status, ...change }; this.broadcast(); }

  notice(text: string, level: NoticeLevel = 'info'): void {
    for (const peer of this.live) if (peer.ready) peer.push({ t: 'notice', text, level });
  }

  /** Answers of `op` wait until `release(op)`. */
  hold(op: Op): void { this.held.add(op); }

  release(op: Op): void {
    this.held.delete(op);
    const due = this.queue.filter(entry => entry.op === op);
    this.queue.splice(0, this.queue.length, ...this.queue.filter(entry => entry.op !== op));
    for (const entry of due) entry.reply();
  }

  /** Ends every peer with `bye 1012`; the next connections see a new boot. */
  restart(): void {
    this.boot = `boot-${++this.boots}`;
    for (const peer of [...this.live]) peer.close(CloseCode.restart, 'The server is restarting');
  }

  private broadcast(): void {
    for (const peer of this.live) peer.sync();
  }

  private syncAgents(): void {
    this.status = { ...this.status, agents: [...this.agents.keys()].map(name => ({ name, role: 'main', parent: 'Pi', busy: false })) };
  }

  private agentNamed(name: string): string | undefined {
    return [...this.agents.keys()].find(agent => agent.toLowerCase() === name.toLowerCase());
  }

  /** Runs a request, as docs/protocol.md's Ops table says. */
  answer(peer: FakePeer, request: Request): void {
    if (SOCKET_ONLY.has(request.op) && peer.peer !== 'socket') { peer.respond(request, fail('forbidden', 'Only on the server\'s socket')); return; }
    if (WEB_ONLY.has(request.op) && peer.peer !== 'web') { peer.respond(request, fail('forbidden', 'Only for web clients')); return; }
    const ok = (result: unknown = null, after?: () => void): void => peer.respond(request, { result }, after);
    const no = (error: ErrorCode, message: string): void => peer.respond(request, fail(error, message));
    switch (request.op) {
      case 'send': {
        const { text, requestId } = request.params;
        if (!text.trim()) { no('bad_request', 'Empty message'); return; }
        if (requestId === undefined || !this.sends.some(sent => sent.requestId === requestId)) {
          this.sends.push({ text, requestId });
          this.setItems([...this.items, { kind: 'user', id: `u${++this.userItems}`, text }]);
        }
        ok();
        return;
      }
      case 'abort': this.aborts++; ok(); return;
      case 'schedule.cancel': {
        const schedules = this.status.schedules ?? [];
        if (!schedules.some(each => each.id === request.params.id)) { no('not_found', `No schedule #${request.params.id}`); return; }
        ok(null, () => this.setStatus({ schedules: schedules.filter(each => each.id !== request.params.id) }));
        return;
      }
      case 'stopAgents': {
        const { name } = request.params;
        const names = name === undefined ? [...this.agents.keys()] : [this.agentNamed(name)].filter(each => each !== undefined);
        for (const each of names) this.agents.delete(each);
        this.syncAgents();
        ok({ names }, () => this.broadcast());
        return;
      }
      case 'feed.open': {
        const name = this.agentNamed(request.params.name);
        if (name === undefined) { no('not_found', `No agent named ${request.params.name}`); return; }
        const feed = peer.openFeed(name);
        ok({ feed }, () => peer.snapshot(feed));
        return;
      }
      case 'feed.close': {
        const { feed } = request.params;
        if (feed === ROOT_FEED) { no('bad_request', 'The root feed cannot be closed'); return; }
        if (!peer.feeds.delete(feed)) { no('not_found', `No open feed ${feed}`); return; }
        ok();
        return;
      }
      case 'feed.resync': {
        const { feed } = request.params;
        if (!peer.feeds.has(feed)) { no('not_found', `No open feed ${feed}`); return; }
        ok(null, () => peer.snapshot(feed));
        return;
      }
      case 'memory.view': ok({ lines: this.view }); return;
      case 'memory.zoom': {
        const line = this.view.find(each => each.id === request.params.id && each.n === request.params.n);
        if (!line) { no('not_found', `No line ${request.params.id}+${request.params.n}; the roots are 0+1, 1+1`); return; }
        ok({ text: `zoomed ${line.text}` });
        return;
      }
      case 'models': ok({ models: this.models }); return;
      case 'model.set': {
        const { provider, id } = request.params;
        const model = this.models.find(each => each.provider === provider && each.id === id);
        if (!model) { no('failed', `Unknown model ${provider}/${id}`); return; }
        if (!model.available) { no('failed', `${provider}/${id} has no credentials`); return; }
        this.status = { ...this.status, model: `${provider}/${id}` };
        ok(null, () => this.broadcast());
        return;
      }
      case 'tools.set': {
        const { enabled, confirm } = request.params;
        if (enabled && confirm !== ENABLE_TOOLS) { no('bad_request', "Turning tools on needs confirm: 'enable-tools'."); return; }
        if (enabled && peer.peer === 'web' && this.tools.remote === 'off') { no('forbidden', 'Tools cannot be turned on from the web'); return; }
        this.status = { ...this.status, toolsEnabled: enabled };
        ok(null, () => {
          this.notice(`Coding tools ${enabled ? 'on' : 'off'} (${peer.device ?? 'terminal'})`, enabled ? 'warn' : 'info');
          this.broadcast();
        });
        return;
      }
      case 'push.subscribe': {
        const { subscription } = request.params;
        if (!subscription.endpoint.startsWith('https:')) { no('bad_request', 'The endpoint must be https'); return; }
        this.subscriptions.set(subscription.endpoint, subscription);
        ok();
        return;
      }
      case 'push.unsubscribe': this.subscriptions.delete(request.params.endpoint); ok(); return;
      case 'admin.backup': this.backups.push(request.params.out); ok({ path: `${request.params.out ?? '/fake/backups'}/backup-1`, bytes: 1234 }); return;
      case 'machine.register': this.machines.push({ op: request.op, enabled: request.params.registration.enabled }); ok(); return;
      case 'machine.set': this.machines.push({ op: request.op, enabled: request.params.enabled }); ok(); return;
      case 'admin.pair': ok({ code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000 }); return;
      case 'admin.devices': ok({ devices: this.devices }); return;
      case 'admin.revoke': {
        const at = this.devices.findIndex(device => device.name === request.params.name);
        if (at < 0) { no('not_found', `No device named ${request.params.name}`); return; }
        this.devices.splice(at, 1);
        ok(null, () => {
          for (const each of [...this.live]) if (each.device === request.params.name) each.close(CloseCode.unauthorized, 'This device was revoked');
        });
      }
    }
  }
}
