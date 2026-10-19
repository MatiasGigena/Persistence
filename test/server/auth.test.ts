import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  authenticate, COOKIE_MAX_AGE_S, deviceCookies, deviceName, Devices, gate, LAST_SEEN_MS, normalizeCode, PAIR_CODE_MS,
  PAIR_TRIES, setCookie,
} from '../../src/server/auth.ts';
import type { Access } from '../../src/server/auth.ts';

const access: Access = { origin: 'https://vps.tail1.ts.net', allowLogins: ['me@example.com', 'alt@example.com'] };

async function open(t: TestContext): Promise<{ devices: Devices; path: string; clock: { now: number } }> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-auth-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const clock = { now: 1_000_000 };
  const path = join(folder, 'serve', 'devices.json');
  return { devices: await Devices.open(path, () => clock.now), path, clock };
}

/** Pairs a device and returns its cookie value. */
async function paired(devices: Devices, name: string): Promise<string> {
  const { code } = await devices.pair();
  const result = devices.redeem(code, name);
  assert.ok('cookie' in result, `pairing ${name}`);
  return result.cookie;
}

const request = (headers: IncomingHttpHeaders, method = 'GET') => ({ method, headers });

test('the login allow-list is an exact match, and the Origin is checked on upgrades and non-GET requests', () => {
  assert.deepEqual(gate(request({}), access), { ok: false, status: 403, reason: 'login' });
  assert.equal(gate(request({ 'tailscale-user-login': 'ME@example.com' }), access).ok, false);
  assert.equal(gate(request({ 'tailscale-user-login': 'me@example.com, alt@example.com' }), access).ok, false);
  assert.deepEqual(gate(request({ 'tailscale-user-login': 'me@example.com' }), access), { ok: true, login: 'me@example.com' });
  assert.equal(gate(request({ 'tailscale-user-login': 'alt@example.com' }, 'HEAD'), access).ok, true);
  const post = { 'tailscale-user-login': 'me@example.com' };
  assert.deepEqual(gate(request(post, 'POST'), access), { ok: false, status: 403, reason: 'origin' });
  assert.equal(gate(request({ ...post, origin: 'https://evil.example' }, 'POST'), access).ok, false);
  assert.equal(gate(request({ ...post, origin: `${access.origin}/` }, 'POST'), access).ok, false);
  assert.equal(gate(request({ ...post, origin: access.origin }, 'POST'), access).ok, true);
  assert.equal(gate(request({ ...post, upgrade: 'websocket' }), access).ok, false, 'a GET upgrade needs the Origin');
  assert.equal(gate(request({ ...post, upgrade: 'websocket', origin: access.origin }), access).ok, true);
});

test('pairing: a one-time Crockford code, normalized when typed, gives a cookie of which only the hash is stored', async t => {
  const { devices, path, clock } = await open(t);
  const { code, expiresAt } = await devices.pair();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(expiresAt, clock.now + PAIR_CODE_MS);
  assert.deepEqual(devices.redeem(code, ''), { error: 'malformed' });
  assert.deepEqual(devices.redeem(code, 'x'.repeat(41)), { error: 'malformed' });
  assert.deepEqual(devices.redeem(code, 'bad\u0007name'), { error: 'malformed' });
  assert.deepEqual(devices.redeem('ABC', 'phone'), { error: 'malformed' });
  const typed = ` ${code.toLowerCase().replace('-', ' ')} `;
  const result = devices.redeem(typed, '  phone  ');
  assert.ok('cookie' in result);
  assert.match(result.cookie, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.deepEqual(result.device, { name: 'phone', pairedAt: clock.now });
  assert.deepEqual(devices.redeem(code, 'tablet'), { error: 'wrong' }, 'one use');

  const text = await readFile(path, 'utf8');
  assert.ok(!text.includes(result.cookie), 'the cookie itself is never stored');
  assert.match(text, /"hash": "[0-9a-f]{64}"/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
  assert.deepEqual(await (await Devices.open(path)).list(), [{ name: 'phone', pairedAt: 1_000_000 }]);
});

test('pairing codes expire, are spent by too many wrong tries, and are not spent by a taken name', async t => {
  const { devices, clock } = await open(t);
  const first = await devices.pair();
  clock.now += PAIR_CODE_MS;
  assert.deepEqual(devices.redeem(first.code, 'phone'), { error: 'wrong' }, 'expired');

  const { code } = await devices.pair();
  const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
  for (let i = 0; i < PAIR_TRIES - 1; i++) assert.deepEqual(devices.redeem(wrong, 'phone'), { error: 'wrong' });
  assert.ok('cookie' in devices.redeem(code, 'phone'), 'still valid after fewer wrong tries than the limit');

  const next = await devices.pair();
  assert.deepEqual(devices.redeem(next.code, 'phone'), { error: 'taken' });
  assert.ok('cookie' in devices.redeem(next.code, 'tablet'), 'a taken name leaves the code unspent');

  const last = await devices.pair();
  const bad = last.code.startsWith('0') ? `1${last.code.slice(1)}` : `0${last.code.slice(1)}`;
  for (let i = 0; i < PAIR_TRIES; i++) devices.redeem(bad, 'laptop');
  assert.deepEqual(devices.redeem(last.code, 'laptop'), { error: 'wrong' }, 'spent by the wrong tries');

  const replaced = await devices.pair();
  await devices.pair();
  assert.deepEqual(devices.redeem(replaced.code, 'laptop'), { error: 'wrong' }, 'a new code replaces the pending one');
});

test('cookies verify by hash, lastSeen is written at most every LAST_SEEN_MS, and revoke forgets the device', async t => {
  const { devices, path, clock } = await open(t);
  const cookie = await paired(devices, 'phone');
  const other = await paired(devices, 'laptop');
  const pairedAt = clock.now;
  const headers = (value: string): IncomingHttpHeaders => ({ 'tailscale-user-login': 'me@example.com', cookie: value });

  assert.deepEqual(authenticate(request(headers('')), access, devices), { ok: false, status: 401, reason: 'unpaired' });
  assert.equal(authenticate(request(headers(`pd_device=${'A'.repeat(43)}`)), access, devices).ok, false);
  assert.equal(authenticate(request(headers(`other=${cookie}`)), access, devices).ok, false);
  assert.deepEqual(authenticate(request({ cookie: `pd_device=${cookie}` }), access, devices), { ok: false, status: 403, reason: 'login' });
  assert.deepEqual(deviceCookies({ cookie: `a=1; pd_device=${cookie}; b=2` }), [cookie]);

  clock.now += 1000;
  const first = authenticate(request(headers(`theme=dark; pd_device=${cookie}`)), access, devices);
  assert.deepEqual(first, { ok: true, login: 'me@example.com', device: { name: 'phone', pairedAt, lastSeen: pairedAt + 1000 } });
  clock.now += LAST_SEEN_MS - 1;
  devices.verify(cookie);
  assert.match(await readFile(path, 'utf8'), new RegExp(`"lastSeen": ${pairedAt + 1000}`), 'throttled');
  clock.now += 1;
  assert.equal(devices.verify(cookie)?.lastSeen, clock.now);
  assert.match(await readFile(path, 'utf8'), new RegExp(`"lastSeen": ${clock.now}`));

  assert.equal(await devices.revoke('nobody'), false);
  assert.equal(await devices.revoke('phone'), true);
  assert.equal(devices.verify(cookie), undefined);
  assert.equal(devices.verify(other)?.name, 'laptop');
  assert.deepEqual((await (await Devices.open(path)).list()).map(d => d.name), ['laptop']);
});

test('helpers: names, codes, the Set-Cookie value, and a damaged devices.json', async t => {
  assert.equal(deviceName(' a '), 'a');
  assert.equal(deviceName(42), undefined);
  assert.equal(normalizeCode('o1il-0OLI'), '01110011');
  assert.equal(normalizeCode('UUUU-UUUU'), undefined, 'no U in Crockford base32');
  assert.equal(setCookie('abc'), `pd_device=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`);
  assert.equal(COOKIE_MAX_AGE_S, 400 * 86_400);
  const { path } = await open(t);
  await writeFile(join(path, '..', '..', 'bad.json'), '{"devices":[{"name":"x"}]}');
  await assert.rejects(Devices.open(join(path, '..', '..', 'bad.json')), /bad\.json is damaged/);
});
