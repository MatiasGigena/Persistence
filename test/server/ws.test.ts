import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { ServeSettings } from '../../src/host/config.ts';
import { CloseCode, LIMITS } from '../../src/protocol/messages.ts';
import { Devices } from '../../src/server/auth.ts';
import type { PeerHub, PeerLink } from '../../src/server/link.ts';
import { HOST, MAX_WS_PAYLOAD, PAIR_RATE, startWebListener } from '../../src/server/transport-ws.ts';
import type { WebListener } from '../../src/server/transport-ws.ts';

const ORIGIN = 'https://vps.tail1.ts.net';
const LOGIN = 'me@example.com';

/** A hub that records its links and what they receive. */
class FakeHub implements PeerHub {
  readonly links: PeerLink[] = [];
  readonly received: string[] = [];
  readonly closed: string[] = [];
  attach(link: PeerLink): void {
    this.links.push(link);
    link.onMessage(text => this.received.push(text));
    link.onClose(() => this.closed.push(link.who));
  }
  closeDevice(name: string, code: CloseCode, reason: string): void {
    for (const link of this.links) if (link.device?.name === name) link.close(code, reason);
  }
}

interface Setup { hub: FakeHub; devices: Devices; listener: WebListener; cookie: string; base: string; log: string[] }

async function setup(t: TestContext): Promise<Setup> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-ws-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const web = join(folder, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>t</title>');
  const roots = { web, protocol: join(folder, 'protocol'), ui: join(folder, 'ui'), marked: join(folder, 'marked') };
  const devices = await Devices.open(join(folder, 'serve', 'devices.json'));
  const { code } = await devices.pair();
  const paired = devices.redeem(code, 'phone');
  assert.ok('cookie' in paired);
  const hub = new FakeHub(), log: string[] = [];
  const settings: ServeSettings = { port: 0, origin: ORIGIN, allowLogins: [LOGIN], remoteTools: 'confirm', toolsIdleMinutes: 30, pushPreview: false };
  const listener = await startWebListener(hub, settings, devices, { roots, log: line => log.push(line) });
  t.after(() => listener.close());
  return { hub, devices, listener, cookie: paired.cookie, base: `127.0.0.1:${listener.port}`, log };
}

const allowed = (cookie: string): Record<string, string> => ({ Origin: ORIGIN, 'Tailscale-User-Login': LOGIN, Cookie: `pd_device=${cookie}` });

function http(base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const [host = '', port = ''] = base.split(':');
  return new Promise((resolve, reject) => {
    httpRequest({ host, port: Number(port), method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end(body);
  });
}

/** The HTTP status an upgrade is refused with, or 101. */
async function upgradeStatus(base: string, headers: Record<string, string>, path = '/ws'): Promise<number> {
  const ws = new WebSocket(`ws://${base}${path}`, { headers });
  return new Promise(resolve => {
    ws.on('unexpected-response', (_request, response: IncomingMessage) => { resolve(response.statusCode ?? 0); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => undefined);
  });
}

async function connect(base: string, cookie: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: allowed(cookie) });
  const messages: string[] = [];
  ws.on('message', data => messages.push(Buffer.isBuffer(data) ? data.toString('utf8') : ''));
  await once(ws, 'open');
  return { ws, messages };
}

/** The close frame `ws` receives next. */
const closeOf = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));

const parse = (text: string | undefined): unknown => JSON.parse(text ?? 'null');
/** One field of a JSON object message. */
const field = (text: string | undefined, key: string): unknown => {
  const value = parse(text);
  return typeof value === 'object' && value !== null && key in value ? Object.entries(value).find(([k]) => k === key)?.[1] : undefined;
};

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'timed out');
}

test('the upgrade needs the login, the Origin and a paired cookie, and is refused before upgrading', async t => {
  const { base, cookie, hub, devices } = await setup(t);
  const all = allowed(cookie);
  const without = (name: string): Record<string, string> => Object.fromEntries(Object.entries(all).filter(([key]) => key !== name));
  assert.equal(HOST, '127.0.0.1');
  assert.equal(await upgradeStatus(base, without('Tailscale-User-Login')), 403);
  assert.equal(await upgradeStatus(base, { ...all, 'Tailscale-User-Login': 'other@example.com' }), 403);
  assert.equal(await upgradeStatus(base, without('Origin')), 403);
  assert.equal(await upgradeStatus(base, { ...all, Origin: 'https://evil.example' }), 403);
  assert.equal(await upgradeStatus(base, without('Cookie')), 401);
  assert.equal(await upgradeStatus(base, { ...all, Cookie: `pd_device=${'x'.repeat(43)}` }), 401);
  assert.equal(await upgradeStatus(base, all, '/other'), 404);
  assert.equal(hub.links.length, 0);
  assert.equal(await upgradeStatus(base, all), 101);
  await until(() => hub.closed.length === 1);
  await devices.revoke('phone');
  assert.equal(await upgradeStatus(base, all), 401, 'a revoked cookie');
});

test('an accepted socket is a web PeerLink: messages pass both ways, in order', async t => {
  const { base, cookie, hub } = await setup(t);
  const { ws, messages } = await connect(base, cookie);
  await until(() => hub.links.length === 1);
  const [link] = hub.links;
  assert.ok(link);
  assert.equal(link.peer, 'web');
  assert.equal(link.who, `${LOGIN}/phone`);
  assert.equal(link.device?.name, 'phone');
  assert.equal(typeof link.buffered(), 'number');
  for (const n of [1, 2, 3]) ws.send(JSON.stringify({ t: 'ping', n }));
  await until(() => hub.received.length === 3);
  assert.deepEqual(hub.received, [1, 2, 3].map(n => JSON.stringify({ t: 'ping', n })));
  link.send('{"t":"pong","n":1}');
  await until(() => messages.length === 1);
  assert.deepEqual(messages, ['{"t":"pong","n":1}']);
  ws.close(1000);
  await until(() => hub.closed.length === 1);
  link.send('{"t":"pong","n":2}');
});

test('close codes: the server sends bye, then a close frame with the same code', async t => {
  const { base, cookie, hub } = await setup(t);
  const { ws, messages } = await connect(base, cookie);
  await until(() => hub.links.length === 1);
  const closed = closeOf(ws);
  hub.closeDevice('phone', CloseCode.unauthorized, 'This device was revoked.');
  assert.deepEqual(await closed, { code: CloseCode.unauthorized, reason: 'This device was revoked.' });
  assert.deepEqual(messages.map(parse), [{ t: 'bye', code: 4001, reason: 'This device was revoked.' }]);

  const second = await connect(base, cookie);
  await until(() => hub.links.length === 2);
  const tooSlow = closeOf(second.ws);
  hub.links[1]?.close(CloseCode.tooSlow, 'x'.repeat(300));
  const slow = await tooSlow;
  assert.equal(slow.code, 4008);
  assert.equal(slow.reason.length, 123, 'the close frame reason is cut; bye has it all');
  assert.equal(String(field(second.messages[0], 'reason')).length, 300);
});

test('frame limits: a long text gets bad_request and the socket stays; over maxPayload closes 1009; binary 1003', async t => {
  const { base, cookie, hub } = await setup(t);
  const { ws, messages } = await connect(base, cookie);
  ws.send('a'.repeat(LIMITS.clientMessage + 1));
  await until(() => messages.length === 1);
  assert.deepEqual(parse(messages[0]), { t: 'res', id: -1, ok: false, error: { code: 'bad_request', message: `A message may be at most ${LIMITS.clientMessage} characters.` } });
  ws.send('{"t":"ping","n":1}');
  await until(() => hub.received.length === 1);
  assert.equal(hub.received[0], '{"t":"ping","n":1}', 'the long text was not delivered; the next one was');

  const closed = closeOf(ws);
  ws.send('a'.repeat(MAX_WS_PAYLOAD + 1));
  assert.equal((await closed).code, 1009);

  const binary = await connect(base, cookie);
  const binaryClosed = closeOf(binary.ws);
  binary.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await binaryClosed).code, 1003);
});

test('/api/me and /api/pair: pairing an unpaired browser, with its errors and rate limit', async t => {
  const { base, cookie, devices, log } = await setup(t);
  const login = { 'Tailscale-User-Login': LOGIN };
  const me = await http(base, 'GET', '/api/me', { ...login, Cookie: `pd_device=${cookie}` });
  assert.deepEqual([me.status, parse(me.body)], [200, { device: 'phone' }]);
  assert.equal(me.headers['cache-control'], 'no-store');
  const unpaired = await http(base, 'GET', '/api/me', login);
  assert.deepEqual([unpaired.status, parse(unpaired.body)], [401, { error: 'unpaired' }]);
  assert.equal((await http(base, 'GET', '/api/me', {})).status, 403);
  assert.equal((await http(base, 'GET', '/', login)).status, 200, 'the app needs only the login');
  assert.equal((await http(base, 'GET', '/', {})).status, 403);
  assert.equal((await http(base, 'GET', '/ws', login)).status, 426);
  assert.equal((await http(base, 'GET', '/api/nope', login)).status, 404);
  assert.equal((await http(base, 'POST', '/', { ...login, Origin: ORIGIN })).status, 405);

  const post = (body: string, headers: Record<string, string> = { ...login, Origin: ORIGIN }) =>
    http(base, 'POST', '/api/pair', { ...headers, 'Content-Type': 'application/json' }, body);
  const { code } = await devices.pair();
  assert.equal((await post(JSON.stringify({ code, name: 'tablet' }), login)).status, 403, 'pairing needs the Origin');
  assert.equal((await http(base, 'GET', '/api/pair', login)).status, 405);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(JSON.stringify({ code, name: '' }))).status, 400);
  assert.equal((await post(JSON.stringify({ code: 'AAAA-AAAA', name: 'tablet' }))).status, code === 'AAAA-AAAA' ? 204 : 401);
  assert.equal((await post(JSON.stringify({ code, name: 'phone' }))).status, 409);
  const ok = await post(JSON.stringify({ code, name: 'tablet' }));
  assert.equal(ok.status, 204);
  const setCookie = ok.headers['set-cookie']?.[0] ?? '';
  assert.match(setCookie, /^pd_device=[\w-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=34560000$/);
  const tablet = await http(base, 'GET', '/api/me', { ...login, Cookie: setCookie.split(';')[0] ?? '' });
  assert.deepEqual(parse(tablet.body), { device: 'tablet' });
  assert.ok(log.some(line => line.includes('paired device "tablet"')));

  for (let i = 5; i < PAIR_RATE.tries; i++) await post('{}');
  const limited = await post(JSON.stringify({ code, name: 'other' }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
});

test('close() ends every socket with bye 1012 and stops listening', async t => {
  const { base, cookie, listener } = await setup(t);
  const { ws, messages } = await connect(base, cookie);
  const closed = closeOf(ws);
  await listener.close();
  assert.equal((await closed).code, CloseCode.restart);
  assert.equal(field(messages[0], 'code'), 1012);
  await assert.rejects(http(base, 'GET', '/', { 'Tailscale-User-Login': LOGIN }), /ECONNREFUSED/);
});
