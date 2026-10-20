// Parsing wire messages from text: JSON, then every field checked and copied by hand from `unknown`. Unknown fields
// are dropped, so a parsed message holds exactly its type's fields. Shared by Node and the browser.
import { ENABLE_TOOLS, ERROR_CODES, LIMITS, OPS } from './messages.ts';
import type {
  AgentStatus, AppendField, ChatItem, ClientMessage, Device, ErrorCode, ItemOp, MemoryStats, ModelChoice, NoticeLevel, Op,
  PushSubscriptionJson, RequestOf, ResponseOf, ServerMessage, SessionStatus, ToolsPolicy, ViewLine,
} from './messages.ts';

/**
 * Why a message did not parse; never sent. `id` is the request's when it could be read, so the server can answer
 * `unknown_op` or `bad_request`. Per the versioning rule a receiver ignores `unknown_type`.
 */
export interface ParseError {
  readonly invalid: 'json' | 'too_large' | 'shape' | 'unknown_type' | 'unknown_op';
  readonly message: string;
  readonly id?: number;
}

export const isParseError = (x: ClientMessage | ServerMessage | ParseError): x is ParseError => 'invalid' in x;

type Obj = Readonly<Record<string, unknown>>;

/** A field that is not what its type says; caught at the top and turned into a ParseError. */
class Bad extends Error {}

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const NOTICE_LEVELS: readonly NoticeLevel[] = ['info', 'warn', 'error'];
const TOOL_STATUS = ['running', 'done', 'error'] as const;
const APPEND_FIELDS: readonly AppendField[] = ['text', 'output', 'args'];
const CONFIRMS: readonly (typeof ENABLE_TOOLS)[] = [ENABLE_TOOLS];

function obj(x: unknown, what: string): Obj {
  if (!isObj(x)) throw new Bad(`${what} must be an object`);
  return x;
}
function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Bad(`${key} must be a string`);
  return v;
}
function optStr(o: Obj, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}
function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new Bad(`${key} must be a boolean`);
  return v;
}
function optBool(o: Obj, key: string): boolean | undefined {
  return o[key] === undefined ? undefined : bool(o, key);
}
/** A safe integer, at least `min`. */
function int(o: Obj, key: string, min = 0): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Bad(`${key} must be an integer >= ${min}`);
  return v;
}
function list<T>(o: Obj, key: string, item: (x: unknown) => T): T[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new Bad(`${key} must be an array`);
  const items: readonly unknown[] = v;
  return items.map(item);
}
function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = o[key];
  const found = values.find(each => each === v);
  if (found === undefined) throw new Bad(`${key} must be one of ${values.join(', ')}`);
  return found;
}
/** `{ ...base, [key]: value }` when `value` is defined: optional fields stay absent rather than undefined. */
function withOptional<T extends object, K extends string, V>(base: T, key: K, value: V | undefined): T & { [P in K]?: V } {
  return value === undefined ? base : { ...base, ...{ [key]: value } };
}

// ------------------------------------------------------------------------------------------------ shared shapes

/** One ChatItem, checked by its kind. */
export function chatItem(x: unknown): ChatItem {
  const o = obj(x, 'item');
  const kind = o.kind, id = str(o, 'id');
  switch (kind) {
    case 'user': return { kind, id, text: str(o, 'text') };
    case 'assistant': case 'thinking': return { kind, id, text: str(o, 'text'), streaming: bool(o, 'streaming') };
    case 'tool': return { kind, id, name: str(o, 'name'), args: str(o, 'args'), output: str(o, 'output'), status: oneOf(o, 'status', TOOL_STATUS) };
    case 'report': return { kind, id, from: str(o, 'from'), text: str(o, 'text') };
    case 'notice': return { kind, id, text: str(o, 'text'), level: oneOf(o, 'level', NOTICE_LEVELS) };
    default: throw new Bad(`unknown item kind ${JSON.stringify(kind) ?? 'undefined'}`);
  }
}

function memoryStats(x: unknown): MemoryStats {
  const o = obj(x, 'memory');
  return {
    messages: int(o, 'messages'), unsummarized: int(o, 'unsummarized'), active: int(o, 'active'), failed: int(o, 'failed'),
    lastError: optStr(o, 'lastError'), viewBytes: int(o, 'viewBytes'), viewLines: int(o, 'viewLines'),
  };
}

function agentStatus(x: unknown): AgentStatus {
  const o = obj(x, 'agent');
  return { name: str(o, 'name'), role: oneOf(o, 'role', ['main', 'sub']), parent: str(o, 'parent'), busy: bool(o, 'busy') };
}

/** A SessionStatus; a missing or null `memory` is undefined (JSON drops undefined). */
export function sessionStatus(x: unknown): SessionStatus {
  const o = obj(x, 'status');
  return {
    model: str(o, 'model'), thinkingLevel: str(o, 'thinkingLevel'), toolsEnabled: bool(o, 'toolsEnabled'),
    busy: bool(o, 'busy'), queued: int(o, 'queued'),
    memory: o.memory === undefined || o.memory === null ? undefined : memoryStats(o.memory),
    agents: list(o, 'agents', agentStatus),
  };
}

function viewLine(x: unknown): ViewLine {
  const o = obj(x, 'line');
  return { id: int(o, 'id'), n: int(o, 'n', 1), text: str(o, 'text') };
}

function modelChoice(x: unknown): ModelChoice {
  const o = obj(x, 'model');
  return withOptional({ provider: str(o, 'provider'), id: str(o, 'id'), name: str(o, 'name'), available: bool(o, 'available') },
    'note', optStr(o, 'note'));
}

function device(x: unknown): Device {
  const o = obj(x, 'device');
  return withOptional({ name: str(o, 'name'), pairedAt: int(o, 'pairedAt') }, 'lastSeen', o.lastSeen === undefined ? undefined : int(o, 'lastSeen'));
}

function subscription(x: unknown): PushSubscriptionJson {
  const o = obj(x, 'subscription'), keys = obj(o.keys, 'keys');
  const expiration = o.expirationTime;
  if (expiration !== undefined && expiration !== null && (typeof expiration !== 'number' || !Number.isFinite(expiration))) {
    throw new Bad('expirationTime must be a number or null');
  }
  return withOptional({ endpoint: str(o, 'endpoint'), keys: { p256dh: str(keys, 'p256dh'), auth: str(keys, 'auth') } },
    'expirationTime', expiration);
}

/** One item op. Unknown op kinds are malformed: a new kind needs a protocol bump. */
export function itemOp(x: unknown): ItemOp {
  const o = obj(x, 'op');
  switch (o.op) {
    case 'put': return withOptional({ op: 'put', item: chatItem(o.item) }, 'before', optStr(o, 'before'));
    case 'append': return { op: 'append', id: str(o, 'id'), field: oneOf(o, 'field', APPEND_FIELDS), at: int(o, 'at'), text: str(o, 'text') };
    case 'del': return { op: 'del', id: str(o, 'id') };
    default: throw new Bad(`unknown item op ${JSON.stringify(o.op) ?? 'undefined'}`);
  }
}

function toolsPolicy(x: unknown): ToolsPolicy {
  const o = obj(x, 'tools');
  const remote = oneOf(o, 'remote', ['confirm', 'off']);
  return o.idleMinutes === undefined ? { remote } : { remote, idleMinutes: int(o, 'idleMinutes', 1) };
}

// ------------------------------------------------------------------------------------------------ requests

/** Each op's request, from its id and raw params. Typed per op, so every op is listed and checked. */
const REQUEST: { readonly [O in Op]: (id: number, p: Obj) => RequestOf<O> } = {
  send: (id, p) => ({ t: 'req', id, op: 'send',
    params: withOptional(withOptional({ text: str(p, 'text') }, 'requestId', optStr(p, 'requestId')), 'steer', optBool(p, 'steer')) }),
  abort: id => ({ t: 'req', id, op: 'abort', params: {} }),
  stopAgents: (id, p) => ({ t: 'req', id, op: 'stopAgents', params: withOptional({}, 'name', optStr(p, 'name')) }),
  'feed.open': (id, p) => ({ t: 'req', id, op: 'feed.open', params: { name: str(p, 'name') } }),
  'feed.close': (id, p) => ({ t: 'req', id, op: 'feed.close', params: { feed: str(p, 'feed') } }),
  'feed.resync': (id, p) => ({ t: 'req', id, op: 'feed.resync', params: { feed: str(p, 'feed') } }),
  'memory.view': id => ({ t: 'req', id, op: 'memory.view', params: {} }),
  'memory.zoom': (id, p) => ({ t: 'req', id, op: 'memory.zoom', params: { id: int(p, 'id'), n: int(p, 'n', 1) } }),
  models: id => ({ t: 'req', id, op: 'models', params: {} }),
  'model.set': (id, p) => ({ t: 'req', id, op: 'model.set', params: { provider: str(p, 'provider'), id: str(p, 'id') } }),
  'tools.set': (id, p) => ({ t: 'req', id, op: 'tools.set', params: withOptional({ enabled: bool(p, 'enabled') }, 'confirm',
    p.confirm === undefined ? undefined : oneOf(p, 'confirm', CONFIRMS)) }),
  'thinking.levels': id => ({ t: 'req', id, op: 'thinking.levels', params: {} }),
  'thinking.set': (id, p) => ({ t: 'req', id, op: 'thinking.set', params: { level: str(p, 'level') } }),
  'push.subscribe': (id, p) => ({ t: 'req', id, op: 'push.subscribe', params: { subscription: subscription(p.subscription) } }),
  'push.unsubscribe': (id, p) => ({ t: 'req', id, op: 'push.unsubscribe', params: { endpoint: str(p, 'endpoint') } }),
  'admin.backup': (id, p) => ({ t: 'req', id, op: 'admin.backup', params: withOptional({}, 'out', optStr(p, 'out')) }),
  'admin.pair': id => ({ t: 'req', id, op: 'admin.pair', params: {} }),
  'admin.devices': id => ({ t: 'req', id, op: 'admin.devices', params: {} }),
  'admin.revoke': (id, p) => ({ t: 'req', id, op: 'admin.revoke', params: { name: str(p, 'name') } }),
};

/** Each op's successful response, from its id and raw result. */
const RESPONSE: { readonly [O in Op]: (id: number, r: unknown) => ResponseOf<O> } = {
  send: id => ({ t: 'res', id, op: 'send', ok: true, result: null }),
  abort: id => ({ t: 'res', id, op: 'abort', ok: true, result: null }),
  stopAgents: (id, r) => ({ t: 'res', id, op: 'stopAgents', ok: true, result: { names: list(obj(r, 'result'), 'names', name) } }),
  'feed.open': (id, r) => ({ t: 'res', id, op: 'feed.open', ok: true, result: { feed: str(obj(r, 'result'), 'feed') } }),
  'feed.close': id => ({ t: 'res', id, op: 'feed.close', ok: true, result: null }),
  'feed.resync': id => ({ t: 'res', id, op: 'feed.resync', ok: true, result: null }),
  'memory.view': (id, r) => ({ t: 'res', id, op: 'memory.view', ok: true, result: { lines: list(obj(r, 'result'), 'lines', viewLine) } }),
  'memory.zoom': (id, r) => ({ t: 'res', id, op: 'memory.zoom', ok: true, result: { text: str(obj(r, 'result'), 'text') } }),
  models: (id, r) => ({ t: 'res', id, op: 'models', ok: true, result: { models: list(obj(r, 'result'), 'models', modelChoice) } }),
  'model.set': id => ({ t: 'res', id, op: 'model.set', ok: true, result: null }),
  'tools.set': id => ({ t: 'res', id, op: 'tools.set', ok: true, result: null }),
  'thinking.levels': (id, r) => ({ t: 'res', id, op: 'thinking.levels', ok: true, result: { levels: list(obj(r, 'result'), 'levels', name) } }),
  'thinking.set': id => ({ t: 'res', id, op: 'thinking.set', ok: true, result: null }),
  'push.subscribe': id => ({ t: 'res', id, op: 'push.subscribe', ok: true, result: null }),
  'push.unsubscribe': id => ({ t: 'res', id, op: 'push.unsubscribe', ok: true, result: null }),
  'admin.backup': (id, r) => {
    const o = obj(r, 'result');
    return { t: 'res', id, op: 'admin.backup', ok: true, result: { path: str(o, 'path'), bytes: int(o, 'bytes') } };
  },
  'admin.pair': (id, r) => {
    const o = obj(r, 'result');
    return { t: 'res', id, op: 'admin.pair', ok: true, result: { code: str(o, 'code'), expiresAt: int(o, 'expiresAt') } };
  },
  'admin.devices': (id, r) => ({ t: 'res', id, op: 'admin.devices', ok: true, result: { devices: list(obj(r, 'result'), 'devices', device) } }),
  'admin.revoke': id => ({ t: 'res', id, op: 'admin.revoke', ok: true, result: null }),
};

/** A string list item: an agent's name or a thinking level. */
function name(x: unknown): string {
  if (typeof x !== 'string') throw new Bad('names must be strings');
  return x;
}

export const isOp = (x: unknown): x is Op => OPS.some(op => op === x);

// ------------------------------------------------------------------------------------------------ messages

/** The JSON object in `text`, with a string `t`, or why not. */
function object(text: string, max: number): { readonly o: Obj } | ParseError {
  if (text.length > max) return { invalid: 'too_large', message: `message over ${max} characters` };
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    return { invalid: 'json', message: error instanceof Error ? error.message : String(error) };
  }
  if (!isObj(value)) return { invalid: 'shape', message: 'a message must be a JSON object' };
  if (typeof value.t !== 'string') return { invalid: 'shape', message: 't must be a string' };
  return { o: value };
}

/** Runs `parse`, turning a Bad field into a ParseError (with `id` when known). */
function checked<T>(parse: () => T, id?: number): T | ParseError {
  try { return parse(); } catch (error) {
    if (!(error instanceof Bad)) throw error;
    return id === undefined ? { invalid: 'shape', message: error.message } : { invalid: 'shape', message: error.message, id };
  }
}

/** A client message (server side). Text longer than LIMITS.clientMessage is refused before parsing. */
export function parseClientMessage(text: string): ClientMessage | ParseError {
  const parsed = object(text, LIMITS.clientMessage);
  if ('invalid' in parsed) return parsed;
  const { o } = parsed;
  switch (o.t) {
    case 'hello': return checked(() => ({ t: 'hello', protocol: int(o, 'protocol'), client: str(o, 'client'), visible: bool(o, 'visible') }));
    case 'visible': return checked(() => ({ t: 'visible', visible: bool(o, 'visible') }));
    case 'ping': return checked(() => ({ t: 'ping', n: int(o, 'n') }));
    case 'req': {
      const id = checked(() => int(o, 'id'));
      if (typeof id !== 'number') return id;
      const { op } = o;
      if (!isOp(op)) return { invalid: 'unknown_op', message: `unknown op ${JSON.stringify(op) ?? 'undefined'}`, id };
      return checked(() => REQUEST[op](id, o.params === undefined ? {} : obj(o.params, 'params')), id);
    }
    default: return { invalid: 'unknown_type', message: `unknown message type ${String(o.t)}` };
  }
}

function errorCode(x: unknown): ErrorCode {
  return ERROR_CODES.find(code => code === x) ?? 'failed';
}

/** A server message (client side). An error code this client does not know reads as `failed`. */
export function parseServerMessage(text: string): ServerMessage | ParseError {
  const parsed = object(text, Number.POSITIVE_INFINITY);
  if ('invalid' in parsed) return parsed;
  const { o } = parsed;
  switch (o.t) {
    case 'welcome': return checked(() => {
      const base = {
        t: 'welcome', protocol: int(o, 'protocol'), server: str(o, 'server'), boot: str(o, 'boot'), assets: str(o, 'assets'),
        peer: oneOf(o, 'peer', ['socket', 'web']), cwd: str(o, 'cwd'), tools: toolsPolicy(o.tools),
      } as const;
      return withOptional(withOptional(base, 'pushKey', optStr(o, 'pushKey')), 'device', optStr(o, 'device'));
    });
    case 'ready': return { t: 'ready' };
    case 'status': return checked(() => ({ t: 'status', status: sessionStatus(o.status) }));
    case 'snapshot': return checked(() => ({ t: 'snapshot', feed: str(o, 'feed'), items: list(o, 'items', chatItem) }));
    case 'items': return checked(() => ({ t: 'items', feed: str(o, 'feed'), ops: list(o, 'ops', itemOp) }));
    case 'feed.end': return checked(() => ({ t: 'feed.end', feed: str(o, 'feed'), reason: str(o, 'reason') }));
    case 'notice': return checked(() => ({ t: 'notice', text: str(o, 'text'), level: oneOf(o, 'level', NOTICE_LEVELS) }));
    case 'pong': return checked(() => ({ t: 'pong', n: int(o, 'n') }));
    case 'bye': return checked(() => ({ t: 'bye', code: int(o, 'code'), reason: str(o, 'reason') }));
    case 'res': {
      const id = checked(() => int(o, 'id', -1));
      if (typeof id !== 'number') return id;
      if (o.ok === false) {
        return checked(() => {
          const error = obj(o.error, 'error');
          return { t: 'res', id, ok: false, error: { code: errorCode(error.code), message: str(error, 'message') } } as const;
        }, id);
      }
      if (o.ok !== true) return { invalid: 'shape', message: 'ok must be a boolean', id };
      const { op } = o;
      if (!isOp(op)) return { invalid: 'shape', message: `a response to an unknown op ${JSON.stringify(op) ?? 'undefined'}`, id };
      return checked(() => RESPONSE[op](id, o.result), id);
    }
    default: return { invalid: 'unknown_type', message: `unknown message type ${String(o.t)}` };
  }
}
