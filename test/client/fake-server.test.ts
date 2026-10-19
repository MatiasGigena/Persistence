// The fixture's own conformance to docs/protocol.md, so client tests (TUI and web) can trust it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { FakeServer } from '../fixtures/fake-server.ts';

const HELLO = JSON.stringify({ t: 'hello', protocol: 1, client: 'test', visible: true });
const req = (id: number, op: string, params: object = {}): string => JSON.stringify({ t: 'req', id, op, params });
const types = (messages: readonly ServerMessage[]): string[] => messages.map(message => message.t);

function peer(server: FakeServer, options: { peer?: 'socket' | 'web'; device?: string } = {}) {
  const sent: string[] = [];
  let ended = false;
  const connection = server.connect({ send: text => sent.push(text), end: () => { ended = true; }, ...options });
  return { connection, sent, ended: () => ended };
}

test('hello gets welcome, status, the root snapshot and ready; requests before it get version', () => {
  const server = new FakeServer({ items: [{ kind: 'user', id: 'e1', text: 'hi' }] });
  const { connection } = peer(server);
  assert.deepEqual(connection.handle(req(1, 'models')), [{ t: 'res', id: 1, ok: false, error: { code: 'version', message: 'Say hello first' } }]);
  assert.deepEqual(connection.handle('{"t":"ping","n":1}'), [], 'ping before hello is ignored');
  const greeting = connection.handle(HELLO);
  assert.deepEqual(types(greeting), ['welcome', 'status', 'snapshot', 'ready']);
  assert.deepEqual(greeting[2], { t: 'snapshot', feed: 'root', items: [{ kind: 'user', id: 'e1', text: 'hi' }] });
  assert.deepEqual(connection.handle('{"t":"ping","n":7}'), [{ t: 'pong', n: 7 }]);
});

test('another protocol gets bye 4000 and the end', () => {
  const { connection, ended } = peer(new FakeServer());
  assert.deepEqual(connection.handle(HELLO.replace('"protocol":1', '"protocol":2')), [{ t: 'bye', code: 4000, reason: 'This server speaks protocol 1' }]);
  assert.equal(ended(), true);
});

test('malformed messages: unknown_op, bad_request with the id or -1, unknown types ignored', () => {
  const { connection } = peer(new FakeServer());
  connection.handle(HELLO);
  assert.deepEqual(connection.handle(req(3, 'launch.rockets')), [{ t: 'res', id: 3, ok: false, error: { code: 'unknown_op', message: 'unknown op "launch.rockets"' } }]);
  const [badParams] = connection.handle(req(4, 'memory.zoom', { id: 'x', n: 1 }));
  assert.ok(badParams?.t === 'res' && !badParams.ok && badParams.id === 4 && badParams.error.code === 'bad_request');
  const [badJson] = connection.handle('{oops');
  assert.ok(badJson?.t === 'res' && !badJson.ok && badJson.id === -1 && badJson.error.code === 'bad_request');
  assert.deepEqual(connection.handle('{"t":"future-thing"}'), []);
});

test('changes go out as ops; ops that need a move go as a snapshot', () => {
  const server = new FakeServer({ items: [{ kind: 'user', id: 'a', text: 'x' }, { kind: 'user', id: 'b', text: 'y' }] });
  const { connection, sent } = peer(server);
  connection.handle(HELLO);
  sent.length = 0;
  server.setItems([{ kind: 'user', id: 'a', text: 'x!' }, { kind: 'user', id: 'b', text: 'y' }]);
  assert.deepEqual(sent.map((text): unknown => JSON.parse(text)), [{ t: 'items', feed: 'root', ops: [{ op: 'append', id: 'a', field: 'text', at: 1, text: '!' }] }]);
  sent.length = 0;
  server.setItems([{ kind: 'user', id: 'b', text: 'y' }, { kind: 'user', id: 'a', text: 'x!' }]);
  assert.match(sent[0] ?? '', /^\{"t":"snapshot"/);
});

test('peers get only their ops: admin from the web and push from the socket are forbidden; tools need confirm', () => {
  const server = new FakeServer({ tools: { remote: 'off', idleMinutes: 30 } });
  const web = peer(server, { peer: 'web', device: 'phone' }).connection;
  const socket = peer(server).connection;
  web.handle(HELLO);
  socket.handle(HELLO);
  const code = (messages: readonly ServerMessage[]): string | undefined => {
    const [first] = messages;
    return first?.t === 'res' ? (first.ok ? 'ok' : first.error.code) : undefined;
  };
  assert.equal(code(web.handle(req(1, 'admin.pair'))), 'forbidden');
  assert.equal(code(socket.handle(req(1, 'push.unsubscribe', { endpoint: 'https://x' }))), 'forbidden');
  assert.equal(code(socket.handle(req(2, 'tools.set', { enabled: true }))), 'bad_request');
  assert.equal(code(web.handle(req(2, 'tools.set', { enabled: true, confirm: 'enable-tools' }))), 'forbidden', 'remote tools off');
  assert.equal(code(socket.handle(req(3, 'tools.set', { enabled: true, confirm: 'enable-tools' }))), 'ok');
  assert.equal(server.status.toolsEnabled, true);
  assert.equal(code(socket.handle(req(4, 'feed.close', { feed: 'root' }))), 'bad_request');
  assert.equal(code(socket.handle(req(5, 'feed.open', { name: 'ghost' }))), 'not_found');
});
