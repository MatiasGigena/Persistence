import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ARCHIVE_TTL_MS as CORE_TTL } from '../../src/agents/index.ts';
import { ARCHIVE_TTL_MS, CloseCode, ERROR_CODES, LIMITS, OPS, ROOT_FEED } from '../../src/protocol/messages.ts';
import type { ClientMessage, Op, RequestOf, ResponseOf, ServerMessage } from '../../src/protocol/messages.ts';
import type { ChatItem, SessionStatus } from '../../src/protocol/session.ts';
import { isParseError, parseClientMessage, parseServerMessage } from '../../src/protocol/parse.ts';
import type { ParseError } from '../../src/protocol/parse.ts';
import { PROTOCOL } from '../../src/protocol/version.ts';

const ITEMS: readonly ChatItem[] = [
  { kind: 'user', id: 'e1', text: 'hi "there"\n' },
  { kind: 'assistant', id: 'live1.0', text: 'Hel', streaming: true },
  { kind: 'thinking', id: 'live1.1', text: 'hmm', streaming: false },
  { kind: 'tool', id: 'tool:c1', name: 'bash', args: '{"command":"ls"}', output: 'a.txt', status: 'done' },
  { kind: 'report', id: 'e2', from: 'Bob', text: 'counted 3 boats' },
  { kind: 'notice', id: 'retry:1', text: 'Retrying', level: 'warn' },
];

const STATUS: SessionStatus = {
  model: 'claude-cli/sonnet', thinkingLevel: 'high', toolsEnabled: false, busy: true, queued: 2,
  memory: { messages: 9, unsummarized: 1, active: 0, failed: 1, lastError: 'refused', viewBytes: 300, viewLines: 4 },
  agents: [{ name: 'Bob', role: 'main', parent: 'Pi', busy: true }, { name: 'Kid', role: 'sub', parent: 'Bob', busy: false },
    { name: 'Old', role: 'main', parent: 'Pi', busy: false, archivedAt: 1_800_000_000_000 },
    { name: 'Coder', role: 'main', parent: 'Pi', busy: false, standing: true }],
  schedules: [{ id: 3, text: 'Check the deploy.', at: 1_800_000_000_000 }, { id: 4, text: 'Morning summary.', at: 1_800_000_060_000, cron: '0 9 * * 1-5' }],
};

/** One request per op: the type makes this table list every op. */
const REQUESTS: { readonly [O in Op]: RequestOf<O> } = {
  send: { t: 'req', id: 1, op: 'send', params: { text: 'hello' } },
  abort: { t: 'req', id: 2, op: 'abort', params: {} },
  stopAgents: { t: 'req', id: 3, op: 'stopAgents', params: { name: 'Bob' } },
  'agents.archive': { t: 'req', id: 40, op: 'agents.archive', params: { name: 'Bob' } },
  'agents.restore': { t: 'req', id: 41, op: 'agents.restore', params: { name: 'Bob' } },
  'feed.open': { t: 'req', id: 4, op: 'feed.open', params: { name: 'Bob' } },
  'feed.close': { t: 'req', id: 5, op: 'feed.close', params: { feed: 'agent:Bob' } },
  'feed.resync': { t: 'req', id: 6, op: 'feed.resync', params: { feed: ROOT_FEED } },
  'memory.view': { t: 'req', id: 7, op: 'memory.view', params: {} },
  'memory.zoom': { t: 'req', id: 8, op: 'memory.zoom', params: { id: 4, n: 4 } },
  models: { t: 'req', id: 9, op: 'models', params: {} },
  'model.set': { t: 'req', id: 10, op: 'model.set', params: { provider: 'openrouter', id: 'vendor/model' } },
  'tools.set': { t: 'req', id: 11, op: 'tools.set', params: { enabled: true, confirm: 'enable-tools' } },
  'thinking.levels': { t: 'req', id: 18, op: 'thinking.levels', params: {} },
  'thinking.set': { t: 'req', id: 19, op: 'thinking.set', params: { level: 'xhigh' } },
  'push.subscribe': { t: 'req', id: 12, op: 'push.subscribe', params: {
    subscription: { endpoint: 'https://push.example/x', expirationTime: null, keys: { p256dh: 'BPk', auth: 'au' } },
  } },
  'push.unsubscribe': { t: 'req', id: 13, op: 'push.unsubscribe', params: { endpoint: 'https://push.example/x' } },
  'admin.backup': { t: 'req', id: 14, op: 'admin.backup', params: { out: '/backups' } },
  'admin.pair': { t: 'req', id: 15, op: 'admin.pair', params: {} },
  'admin.devices': { t: 'req', id: 16, op: 'admin.devices', params: {} },
  'admin.revoke': { t: 'req', id: 17, op: 'admin.revoke', params: { name: 'phone' } },
  'machine.register': { t: 'req', id: 18, op: 'machine.register', params: { registration: {
    target: { machineId: 'pc-1', cwd: '/projects', label: 'PC' }, enabled: false } } },
  'machine.set': { t: 'req', id: 19, op: 'machine.set', params: { enabled: true, confirm: 'enable-tools' } },
  'machine.list': { t: 'req', id: 20, op: 'machine.list', params: {} },  'schedule.cancel': { t: 'req', id: 43, op: 'schedule.cancel', params: { id: 3 } },
};

/** One successful response per op. */
const RESPONSES: { readonly [O in Op]: ResponseOf<O> } = {
  send: { t: 'res', id: 1, op: 'send', ok: true, result: null },
  abort: { t: 'res', id: 2, op: 'abort', ok: true, result: null },
  stopAgents: { t: 'res', id: 3, op: 'stopAgents', ok: true, result: { names: ['Kid', 'Bob'] } },
  'agents.archive': { t: 'res', id: 40, op: 'agents.archive', ok: true, result: { names: ['Kid', 'Bob'] } },
  'agents.restore': { t: 'res', id: 41, op: 'agents.restore', ok: true, result: { names: [] } },
  'feed.open': { t: 'res', id: 4, op: 'feed.open', ok: true, result: { feed: 'agent:Bob' } },
  'feed.close': { t: 'res', id: 5, op: 'feed.close', ok: true, result: null },
  'feed.resync': { t: 'res', id: 6, op: 'feed.resync', ok: true, result: null },
  'memory.view': { t: 'res', id: 7, op: 'memory.view', ok: true, result: { lines: [{ id: 0, n: 4, text: 'early' }, { id: 4, n: 1, text: 'user: hi' }] } },
  'memory.zoom': { t: 'res', id: 8, op: 'memory.zoom', ok: true, result: { text: '4+1|user: hi' } },
  models: { t: 'res', id: 9, op: 'models', ok: true, result: { models: [
    { provider: 'faux', id: 'a', name: 'Faux A', available: true },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Sonnet', available: false, note: 'needs ANTHROPIC_API_KEY' },
  ] } },
  'model.set': { t: 'res', id: 10, op: 'model.set', ok: true, result: null },
  'tools.set': { t: 'res', id: 11, op: 'tools.set', ok: true, result: null },
  'thinking.levels': { t: 'res', id: 18, op: 'thinking.levels', ok: true, result: { levels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'thinking.set': { t: 'res', id: 19, op: 'thinking.set', ok: true, result: null },
  'push.subscribe': { t: 'res', id: 12, op: 'push.subscribe', ok: true, result: null },
  'push.unsubscribe': { t: 'res', id: 13, op: 'push.unsubscribe', ok: true, result: null },
  'admin.backup': { t: 'res', id: 14, op: 'admin.backup', ok: true, result: { path: '/backups/2026-10-19', bytes: 1234 } },
  'admin.pair': { t: 'res', id: 15, op: 'admin.pair', ok: true, result: { code: 'K7Q2-M9XD', expiresAt: 1_800_000_000_000 } },
  'admin.devices': { t: 'res', id: 16, op: 'admin.devices', ok: true, result: { devices: [
    { name: 'phone', pairedAt: 1_700_000_000_000, lastSeen: 1_700_000_100_000 }, { name: 'laptop', pairedAt: 1_700_000_000_000 },
  ] } },
  'admin.revoke': { t: 'res', id: 17, op: 'admin.revoke', ok: true, result: null },
  'machine.register': { t: 'res', id: 18, op: 'machine.register', ok: true, result: null },
  'machine.set': { t: 'res', id: 19, op: 'machine.set', ok: true, result: null },
  'machine.list': { t: 'res', id: 20, op: 'machine.list', ok: true, result: { machines: [] } },
  'schedule.cancel': { t: 'res', id: 43, op: 'schedule.cancel', ok: true, result: null },
};

const CLIENT: readonly ClientMessage[] = [
  { t: 'hello', protocol: PROTOCOL, client: 'pi-durable-tui 0.1.0', visible: true },
  { t: 'visible', visible: false },
  { t: 'ping', n: 7 },
  ...Object.values(REQUESTS),
  { t: 'req', id: 20, op: 'stopAgents', params: {} },
  { t: 'req', id: 42, op: 'agents.archive', params: { adhoc: true } },
  { t: 'req', id: 24, op: 'send', params: { text: 'again', requestId: 'tui-1a2b-7' } },
  { t: 'req', id: 25, op: 'send', params: { text: 'not that one', requestId: 'web-1', steer: true } },
  { t: 'req', id: 26, op: 'send', params: { text: '', requestId: 'web-2', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } },
  { t: 'req', id: 21, op: 'tools.set', params: { enabled: false } },
  { t: 'req', id: 22, op: 'admin.backup', params: {} },
  { t: 'req', id: 23, op: 'push.subscribe', params: { subscription: { endpoint: 'https://e', keys: { p256dh: 'p', auth: 'a' } } } },
];

const SERVER: readonly ServerMessage[] = [
  { t: 'welcome', protocol: PROTOCOL, server: '0.1.0', boot: 'b1', assets: 'a1', peer: 'socket', cwd: '/home/u/projects',
    tools: { remote: 'confirm', idleMinutes: 30 } },
  { t: 'welcome', protocol: PROTOCOL, server: '0.1.0', boot: 'b1', assets: 'a1', peer: 'web', cwd: '/p',
    tools: { remote: 'off', idleMinutes: 5 }, pushKey: 'BAbc', device: 'phone' },
  { t: 'ready' },
  { t: 'status', status: STATUS },
  { t: 'status', status: { ...STATUS, memory: undefined, agents: [] } },
  { t: 'status', status: { ...STATUS, memory: { messages: 0, unsummarized: 0, active: 0, failed: 0, lastError: undefined, viewBytes: 0, viewLines: 0 } } },
  { t: 'snapshot', feed: ROOT_FEED, items: ITEMS },
  { t: 'snapshot', feed: 'agent:Bob', items: [] },
  { t: 'items', feed: ROOT_FEED, ops: [
    { op: 'put', item: ITEMS[0] ?? assert.fail() }, { op: 'put', item: ITEMS[3] ?? assert.fail(), before: 'e1' },
    { op: 'append', id: 'live1.0', field: 'text', at: 3, text: 'lo' }, { op: 'append', id: 'tool:c1', field: 'output', at: 5, text: '\n' },
    { op: 'append', id: 'tool:c1', field: 'args', at: 0, text: '{' }, { op: 'del', id: 'e2' },
  ] },
  { t: 'feed.end', feed: 'agent:Bob', reason: 'Bob is gone.' },
  { t: 'notice', text: 'Coding tools on (from phone)', level: 'warn' },
  ...Object.values(RESPONSES),
  { t: 'res', id: 15, op: 'admin.pair', ok: true, result: { code: 'K7Q2-M9XD', expiresAt: 1_800_000_000_000, origin: 'https://pi.tail1.ts.net' } },
  ...ERROR_CODES.map((code, i): ServerMessage => ({ t: 'res', id: 30 + i, ok: false, error: { code, message: `${code} happened` } })),
  { t: 'res', id: -1, ok: false, error: { code: 'bad_request', message: 'id must be an integer' } },
  { t: 'pong', n: 7 },
  { t: 'bye', code: CloseCode.tooSlow, reason: 'too slow' },
];

const invalid = (result: ClientMessage | ServerMessage | ParseError): ParseError['invalid'] | undefined =>
  isParseError(result) ? result.invalid : undefined;

describe('parsing', () => {
  test('every op has a request and a response sample', () => {
    assert.deepEqual(Object.keys(REQUESTS), [...OPS]);
    assert.deepEqual(Object.keys(RESPONSES), [...OPS]);
  });

  test('every client message round-trips through JSON', () => {
    for (const message of CLIENT) assert.deepEqual(parseClientMessage(JSON.stringify(message)), message, message.t);
  });

  test('every server message round-trips through JSON', () => {
    for (const message of SERVER) assert.deepEqual(parseServerMessage(JSON.stringify(message)), message, JSON.stringify(message));
  });

  test('unknown fields are dropped, missing params read as none, and unknown error codes as failed', () => {
    assert.deepEqual(parseClientMessage('{"t":"ping","n":1,"extra":true}'), { t: 'ping', n: 1 });
    assert.deepEqual(parseClientMessage('{"t":"req","id":1,"op":"abort"}'), { t: 'req', id: 1, op: 'abort', params: {} });
    assert.deepEqual(parseClientMessage('{"t":"req","id":1,"op":"send","params":{"text":"x","later":1}}'),
      { t: 'req', id: 1, op: 'send', params: { text: 'x' } });
    assert.deepEqual(parseServerMessage('{"t":"res","id":2,"ok":false,"error":{"code":"teapot","message":"m"}}'),
      { t: 'res', id: 2, ok: false, error: { code: 'failed', message: 'm' } });
    assert.deepEqual(parseServerMessage('{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"memory":null,"agents":[]}}'),
      { t: 'status', status: { model: 'm', thinkingLevel: 'off', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [] } });
  });

  test('the archive TTL clients show is the core\'s', () => {
    assert.equal(ARCHIVE_TTL_MS, CORE_TTL);
  });

  test('an unknown message type is reported as such, for the receiver to ignore', () => {
    assert.equal(invalid(parseClientMessage('{"t":"subscribe","x":1}')), 'unknown_type');
    assert.equal(invalid(parseServerMessage('{"t":"presence"}')), 'unknown_type');
  });

  test('an unknown op keeps the request id, so the server can answer unknown_op', () => {
    assert.deepEqual(parseClientMessage('{"t":"req","id":5,"op":"memory.drop","params":{}}'),
      { invalid: 'unknown_op', message: 'unknown op "memory.drop"', id: 5 });
    const bad = parseClientMessage('{"t":"req","id":6,"op":"send","params":{"text":7}}');
    assert.ok(isParseError(bad) && bad.invalid === 'shape' && bad.id === 6, JSON.stringify(bad));
  });

  test('malformed client messages are refused', () => {
    const cases: readonly (readonly [string, ParseError['invalid']])[] = [
      ['', 'json'], ['{', 'json'], ['nul', 'json'],
      ['null', 'shape'], ['[]', 'shape'], ['"hello"', 'shape'], ['7', 'shape'], ['{}', 'shape'], ['{"t":7}', 'shape'],
      ['{"t":"hello","protocol":"1","client":"x","visible":true}', 'shape'],
      ['{"t":"hello","protocol":2,"visible":true}', 'shape'],
      ['{"t":"hello","protocol":-1,"client":"x","visible":true}', 'shape'],
      ['{"t":"hello","protocol":2.5,"client":"x","visible":true}', 'shape'],
      ['{"t":"hello","protocol":2,"client":"x","visible":"yes"}', 'shape'],
      ['{"t":"visible"}', 'shape'], ['{"t":"ping","n":-2}', 'shape'], ['{"t":"ping"}', 'shape'],
      ['{"t":"req","op":"abort"}', 'shape'], ['{"t":"req","id":-1,"op":"abort"}', 'shape'], ['{"t":"req","id":"1","op":"abort"}', 'shape'],
      ['{"t":"req","id":1e300,"op":"abort"}', 'shape'], ['{"t":"req","id":1}', 'unknown_op'], ['{"t":"req","id":1,"op":7}', 'unknown_op'],
      ['{"t":"req","id":1,"op":"abort","params":[]}', 'shape'], ['{"t":"req","id":1,"op":"abort","params":"x"}', 'shape'],
      ['{"t":"req","id":1,"op":"send","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"send","params":{"text":"x","requestId":5}}', 'shape'],
      ['{"t":"req","id":1,"op":"send","params":{"text":"x","steer":"yes"}}', 'shape'],
      ['{"t":"req","id":1,"op":"send","params":{"text":"x","images":{}}}', 'shape'],
      ['{"t":"req","id":1,"op":"send","params":{"text":"x","images":[{"mimeType":"image/png"}]}}', 'shape'],
      ['{"t":"req","id":1,"op":"stopAgents","params":{"name":5}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{"name":""}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{"name":5}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{"adhoc":false}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{"adhoc":"yes"}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.archive","params":{"name":"Bob","adhoc":true}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.restore","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.restore","params":{"adhoc":true}}', 'shape'],
      ['{"t":"req","id":1,"op":"agents.restore","params":{"name":"  "}}', 'shape'],
      ['{"t":"req","id":1,"op":"schedule.cancel","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"schedule.cancel","params":{"id":0}}', 'shape'],
      ['{"t":"req","id":1,"op":"schedule.cancel","params":{"id":"3"}}', 'shape'],
      ['{"t":"req","id":1,"op":"feed.open","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"feed.close","params":{"feed":null}}', 'shape'],
      ['{"t":"req","id":1,"op":"feed.resync","params":{"feed":1}}', 'shape'],
      ['{"t":"req","id":1,"op":"memory.zoom","params":{"id":0,"n":0}}', 'shape'],
      ['{"t":"req","id":1,"op":"memory.zoom","params":{"id":-4,"n":1}}', 'shape'],
      ['{"t":"req","id":1,"op":"memory.zoom","params":{"id":"0","n":1}}', 'shape'],
      ['{"t":"req","id":1,"op":"model.set","params":{"provider":"p"}}', 'shape'],
      ['{"t":"req","id":1,"op":"tools.set","params":{"enabled":"true"}}', 'shape'],
      ['{"t":"req","id":1,"op":"tools.set","params":{"enabled":true,"confirm":"yes"}}', 'shape'],
      ['{"t":"req","id":1,"op":"push.subscribe","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"push.subscribe","params":{"subscription":{"endpoint":"e","keys":{"p256dh":"p"}}}}', 'shape'],
      ['{"t":"req","id":1,"op":"push.subscribe","params":{"subscription":{"endpoint":"e","expirationTime":"soon","keys":{"p256dh":"p","auth":"a"}}}}', 'shape'],
      ['{"t":"req","id":1,"op":"push.unsubscribe","params":{}}', 'shape'],
      ['{"t":"req","id":1,"op":"admin.backup","params":{"out":false}}', 'shape'],
      ['{"t":"req","id":1,"op":"admin.revoke","params":{}}', 'shape'],
      [`{"t":"req","id":1,"op":"send","params":{"text":"${'x'.repeat(LIMITS.clientMessage)}"}}`, 'too_large'],
    ];
    for (const [text, why] of cases) assert.equal(invalid(parseClientMessage(text)), why, text.slice(0, 120));
  });

  test('malformed server messages are refused, nested items and ops included', () => {
    const item = '{"kind":"user","id":"u","text":"t"}';
    const cases: readonly (readonly [string, ParseError['invalid']])[] = [
      ['{"t":"welcome","protocol":2}', 'shape'],
      ['{"t":"welcome","protocol":2,"server":"s","boot":"b","assets":"a","peer":"lan","cwd":"/","tools":{"remote":"confirm","idleMinutes":30}}', 'shape'],
      ['{"t":"welcome","protocol":2,"server":"s","boot":"b","assets":"a","peer":"web","cwd":"/","tools":{"remote":"maybe","idleMinutes":30}}', 'shape'],
      ['{"t":"welcome","protocol":2,"server":"s","boot":"b","assets":"a","peer":"web","cwd":"/","tools":{"remote":"off","idleMinutes":0}}', 'shape'],
      ['{"t":"welcome","protocol":2,"server":"s","boot":"b","assets":"a","peer":"web","cwd":"/","tools":{"remote":"off","idleMinutes":3},"pushKey":1}', 'shape'],
      ['{"t":"status"}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":-1,"agents":[]}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":{}}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":[{"name":"B","role":"boss","parent":"Pi","busy":true}]}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":[],"memory":{"messages":1}}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":[],"memory":{"messages":1,"unsummarized":0,"active":0,"failed":0,"lastError":3,"viewBytes":0,"viewLines":0}}}', 'shape'],
      ['{"t":"snapshot","items":[]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"user","id":"u"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"image","id":"u"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"assistant","id":"a","text":"x","streaming":1}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"tool","id":"t","name":"n","args":"","output":"","status":"lost"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"notice","id":"n","text":"x","level":"fatal"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"report","id":"r","text":"x"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[{"kind":"user","text":"t"}]}', 'shape'],
      ['{"t":"snapshot","feed":"root","items":[null]}', 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"move","id":"u"}]}', 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"put"}]}', 'shape'],
      [`{"t":"items","feed":"root","ops":[{"op":"put","item":${item},"before":3}]}`, 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"append","id":"u","field":"name","at":0,"text":"x"}]}', 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"append","id":"u","field":"text","at":-1,"text":"x"}]}', 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"append","id":"u","field":"text","at":0}]}', 'shape'],
      ['{"t":"items","feed":"root","ops":[{"op":"del"}]}', 'shape'],
      ['{"t":"items","feed":"root","ops":{}}', 'shape'],
      ['{"t":"feed.end","feed":"x"}', 'shape'],
      ['{"t":"notice","text":"x","level":"loud"}', 'shape'],
      ['{"t":"pong"}', 'shape'], ['{"t":"bye","code":4000}', 'shape'], ['{"t":"bye","code":"4000","reason":""}', 'shape'],
      ['{"t":"res","ok":true,"op":"send","result":null}', 'shape'],
      ['{"t":"res","id":1,"op":"send","result":null}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"unheard.of","result":null}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"feed.open","result":{}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"stopAgents","result":{"names":[1]}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"agents.archive","result":{}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"agents.restore","result":{"names":[null]}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":[{"name":"B","role":"main","parent":"Pi","busy":false,"archivedAt":"today"}]}}', 'shape'],
      ['{"t":"status","status":{"model":"m","thinkingLevel":"off","toolsEnabled":false,"busy":false,"queued":0,"agents":[{"name":"B","role":"main","parent":"Pi","busy":false,"standing":false}]}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"memory.view","result":{"lines":[{"id":0,"n":0,"text":"x"}]}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"memory.zoom","result":null}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"models","result":{"models":[{"provider":"p","id":"i","name":"n"}]}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"admin.backup","result":{"path":"/b"}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"admin.pair","result":{"code":"c","expiresAt":"later"}}', 'shape'],
      ['{"t":"res","id":1,"ok":true,"op":"admin.devices","result":{"devices":[{"name":"p"}]}}', 'shape'],
      ['{"t":"res","id":1,"ok":false}', 'shape'], ['{"t":"res","id":1,"ok":false,"error":{"code":"failed"}}', 'shape'],
      ['{"t":"res","id":-2,"ok":false,"error":{"code":"failed","message":"m"}}', 'shape'],
      ['not json', 'json'], ['[]', 'shape'], ['{"t":null}', 'shape'],
    ];
    for (const [text, why] of cases) assert.equal(invalid(parseServerMessage(text)), why, text);
  });
});
