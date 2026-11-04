import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import type { ECDH, KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isRecord } from '../../src/protocol/util.ts';
import type { PushSubscriptionJson } from '../../src/protocol/messages.ts';
import {
  InvalidSubscription, createPush, encryptPayload, isPushServiceEndpoint, topicOf, vapidJwt,
} from '../../src/server/push.ts';
import type { PushOptions } from '../../src/server/push.ts';

const b64 = (text: string): Buffer => Buffer.from(text, 'base64url');

describe('aes128gcm (RFC 8291)', () => {
  test('Appendix A: the example message encrypts to the exact body', () => {
    const asKeys = createECDH('prime256v1');
    asKeys.setPrivateKey(b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    assert.equal(asKeys.getPublicKey().toString('base64url'),
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b64('BTBZMqHH6r4Tts7J_aSIgg'),
      { salt: b64('DGv6ra1nlYgDCS1FRnbzlw'), ecdh: asKeys },
    );
    assert.equal(body.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_'
      + 'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  test('a fresh encryption decrypts with the user agent\'s keys', () => {
    const ua = userAgent();
    const body = encryptPayload(Buffer.from('héllo'), ua.ecdh.getPublicKey(), ua.auth);
    assert.equal(decrypt(body, ua.ecdh, ua.auth), 'héllo');
  });
});

describe('VAPID', () => {
  test('the JWT verifies against the public key and carries aud, exp and sub', async () => {
    const dir = await tempDir();
    const push = await createPush(paths(dir), { origin: 'https://box.tailnet.ts.net' });
    const key = createPrivateKeyOf(await readFile(join(dir, 'serve', 'vapid.json'), 'utf8'));
    const jwt = vapidJwt(key, 'https://fcm.googleapis.com', 'mailto:me@example.com', 1_700_000_000_000);
    const claims = checkJwt(jwt, push.publicKey);
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:me@example.com' });
    await rm(dir, { recursive: true, force: true });
  });

  test('the key pair is created once, mode 600, and kept across opens', async () => {
    const dir = await tempDir();
    const first = await createPush(paths(dir), {});
    assert.equal(b64(first.publicKey).length, 65);
    assert.equal(b64(first.publicKey)[0], 4);
    assert.equal((await stat(join(dir, 'serve'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'serve', 'vapid.json'))).mode & 0o777, 0o600);
    const second = await createPush(paths(dir), {});
    assert.equal(second.publicKey, first.publicKey);
    await rm(dir, { recursive: true, force: true });
  });

  test('a damaged vapid.json is refused, not replaced', async () => {
    const dir = await tempDir();
    await createPush(paths(dir), {});
    await writeFile(join(dir, 'serve', 'vapid.json'), '{"kty":"EC"}');
    await assert.rejects(createPush(paths(dir), {}), /not a P-256 private key/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('subscriptions', () => {
  const keys = (): PushSubscriptionJson['keys'] => {
    const ua = userAgent();
    return { p256dh: ua.ecdh.getPublicKey().toString('base64url'), auth: ua.auth.toString('base64url') };
  };

  test('the default endpoint check takes push services only', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QF8', 'https://wns2-par02p.notify.windows.com/w/?token=x',
      'https://updates.push.services.mozilla.com/wpush/v2/x']) {
      assert.ok(isPushServiceEndpoint(new URL(ok)), ok);
    }
    for (const bad of ['http://fcm.googleapis.com/fcm/send/abc', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x',
      'https://10.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://push.apple.com.evil.example/x',
      'https://evilpush.apple.com/x', 'https://box.tailnet.ts.net/x', 'https://fcm.googleapis.com./x']) {
      assert.ok(!isPushServiceEndpoint(new URL(bad)), bad);
    }
  });

  test('subscribe rejects http, IPs, localhost and bad keys, and stores the rest with mode 600', async () => {
    const dir = await tempDir();
    const push = await createPush(paths(dir), {}, { now: () => 42 });
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/a', 'https://192.168.1.2/a', 'https://localhost/a', 'not a url']) {
      await assert.rejects(push.subscribe({ endpoint, keys: keys() }, 'phone'), InvalidSubscription, endpoint);
    }
    const endpoint = 'https://fcm.googleapis.com/fcm/send/a';
    await assert.rejects(push.subscribe({ endpoint, keys: { ...keys(), p256dh: 'BAAA' } }, 'phone'), /p256dh/);
    await assert.rejects(push.subscribe({ endpoint, keys: { ...keys(), p256dh: Buffer.alloc(65, 4).toString('base64url') } }, 'phone'), /p256dh/);
    await assert.rejects(push.subscribe({ endpoint, keys: { ...keys(), auth: 'AAAA' } }, 'phone'), /auth/);
    const good = keys();
    await push.subscribe({ endpoint, expirationTime: null, keys: good }, 'phone');
    const file = join(dir, 'serve', 'push.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { subscriptions: { [endpoint]: { keys: good, device: 'phone', createdAt: 42 } } });
    await push.unsubscribe('https://fcm.googleapis.com/fcm/send/unknown');
    await push.unsubscribe(endpoint);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { subscriptions: {} });
    await rm(dir, { recursive: true, force: true });
  });

  test('new VAPID keys drop the subscriptions made under the old ones', async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    const push = await createPush(paths(dir), {});
    await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: keys() }, 'phone');
    await rm(join(dir, 'serve', 'vapid.json'));
    await createPush(paths(dir), {}, { log: line => lines.push(line) });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'serve', 'push.json'), 'utf8')), { subscriptions: {} });
    assert.match(lines.join('\n'), /dropped 1 subscription/);
    await rm(dir, { recursive: true, force: true });
  });

  test('forgetDevice drops a device\'s subscriptions only', async () => {
    const dir = await tempDir();
    const push = await createPush(paths(dir), {});
    await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: keys() }, 'phone');
    await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/b', keys: keys() }, 'phone');
    await push.subscribe({ endpoint: 'https://web.push.apple.com/c', keys: keys() }, 'tablet');
    assert.equal(await push.forgetDevice('phone'), 2);
    const stored: unknown = JSON.parse(await readFile(join(dir, 'serve', 'push.json'), 'utf8'));
    assert.ok(isRecord(stored) && isRecord(stored.subscriptions));
    assert.deepEqual(Object.keys(stored.subscriptions), ['https://web.push.apple.com/c']);
    await rm(dir, { recursive: true, force: true });
  });

  test('topics are base64url and at most 32 characters', () => {
    assert.equal(topicOf('pi'), 'pi');
    assert.match(topicOf('agent:Bob the builder, a long agent name'), /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(topicOf('agent:a'), topicOf('agent:b'));
  });
});

describe('sending', () => {
  interface Received { readonly url: string; readonly headers: IncomingHttpHeaders; readonly body: Buffer }
  let server: Server, origin = '';
  const received: Received[] = [];
  let answer: (count: number) => { status: number; headers?: Record<string, string> } = () => ({ status: 201 });

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        const { status, headers } = answer(received.length);
        res.writeHead(status, headers).end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen() on a port gives AddressInfo
  });
  after(() => { server.close(); });

  /** A notifier allowed to post to the local server, with one subscription per entry of `devices`. */
  async function setup(devices: readonly string[], options: PushOptions = {}) {
    received.length = 0;
    const dir = await tempDir();
    const push = await createPush(paths(dir), { origin: 'https://box.tailnet.ts.net' },
      { allowEndpoint: url => url.origin === origin, ...options });
    const agents = await Promise.all(devices.map(async device => {
      const ua = userAgent();
      const endpoint = `${origin}/push/${device}`;
      await push.subscribe({ endpoint, keys: { p256dh: ua.ecdh.getPublicKey().toString('base64url'), auth: ua.auth.toString('base64url') } }, device);
      return { ...ua, endpoint };
    }));
    const stored = async (): Promise<string[]> => {
      const json: unknown = JSON.parse(await readFile(join(dir, 'serve', 'push.json'), 'utf8'));
      return isRecord(json) && isRecord(json.subscriptions) ? Object.keys(json.subscriptions) : [];
    };
    return { dir, push, agents, stored };
  }

  test('201: one encrypted POST per subscription, with VAPID and the headers', async () => {
    answer = () => ({ status: 201 });
    const { dir, push, agents } = await setup(['phone', 'tablet']);
    await push.notify({ title: 'Pi answered', body: 'Here is the plan.', tag: 'pi' });
    assert.equal(received.length, 2);
    for (const agent of agents) {
      const request = received.find(r => `${origin}${r.url}` === agent.endpoint);
      assert.ok(request);
      assert.equal(request.headers['content-encoding'], 'aes128gcm');
      assert.equal(request.headers.ttl, '86400');
      assert.equal(request.headers.urgency, 'normal');
      assert.equal(request.headers.topic, 'pi');
      const match = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.authorization ?? '');
      assert.ok(match?.[1] && match[2]);
      assert.equal(match[2], push.publicKey);
      const claims = checkJwt(match[1], push.publicKey);
      assert.ok(isRecord(claims));
      assert.equal(claims.aud, origin);
      assert.equal(claims.sub, 'mailto:pi-durable@box.tailnet.ts.net');
      assert.deepEqual(JSON.parse(decrypt(request.body, agent.ecdh, agent.auth)), { title: 'Pi answered', body: 'Here is the plan.', tag: 'pi' });
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('a long body is cut to fit one push', async () => {
    answer = () => ({ status: 201 });
    const { dir, push, agents } = await setup(['phone']);
    await push.notify({ title: 'Pi answered', body: '\u0001'.repeat(5000), tag: 'pi' });
    const [request] = received, [agent] = agents;
    assert.ok(request && agent);
    assert.ok(request.body.length <= 4096);
    const payload: unknown = JSON.parse(decrypt(request.body, agent.ecdh, agent.auth));
    assert.ok(isRecord(payload) && typeof payload.body === 'string' && payload.body.endsWith('…'));
    await rm(dir, { recursive: true, force: true });
  });

  test('410 drops the subscription; later pushes skip it', async () => {
    answer = () => ({ status: 410 });
    const lines: string[] = [];
    const { dir, push, stored } = await setup(['phone'], { log: line => lines.push(line) });
    await push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 1);
    assert.deepEqual(await stored(), []);
    assert.match(lines.join('\n'), /dropped .*\(phone\).*410/);
    assert.doesNotMatch(lines.join('\n'), /\/push\//, 'endpoints are logged by origin only');
    await push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 1);
    await rm(dir, { recursive: true, force: true });
  });

  test('429 is retried once after Retry-After', async () => {
    answer = count => count === 1 ? { status: 429, headers: { 'Retry-After': '0' } } : { status: 201 };
    const { dir, push, stored, agents } = await setup(['phone']);
    await push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 2);
    assert.deepEqual(await stored(), agents.map(agent => agent.endpoint));
    await rm(dir, { recursive: true, force: true });
  });

  test('a 5xx is retried only once; a Retry-After over 60 s is not waited for', async () => {
    answer = () => ({ status: 503, headers: { 'Retry-After': '0' } });
    const first = await setup(['phone']);
    await first.push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 2);
    assert.deepEqual(await first.stored(), first.agents.map(agent => agent.endpoint));
    await rm(first.dir, { recursive: true, force: true });

    answer = () => ({ status: 429, headers: { 'Retry-After': '120' } });
    const lines: string[] = [];
    const second = await setup(['phone'], { log: line => lines.push(line) });
    await second.push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 1);
    assert.match(lines.join('\n'), /HTTP 429/);
    await rm(second.dir, { recursive: true, force: true });
  });

  test('another 4xx is logged, not retried, and keeps the subscription', async () => {
    answer = () => ({ status: 403 });
    const lines: string[] = [];
    const { dir, push, stored, agents } = await setup(['phone'], { log: line => lines.push(line) });
    await push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.equal(received.length, 1);
    assert.match(lines.join('\n'), /HTTP 403/);
    assert.deepEqual(await stored(), agents.map(agent => agent.endpoint));
    await rm(dir, { recursive: true, force: true });
  });

  test('notify never rejects', async () => {
    let broken = false;
    const lines: string[] = [];
    const { dir, push } = await setup(['phone'], {
      log: line => lines.push(line),
      now: () => { if (broken) throw new Error('clock'); return 0; },
    });
    broken = true;
    await push.notify({ title: 'Pi answered', body: '', tag: 'pi' });
    assert.match(lines.join('\n'), /notify failed: clock/);
    await rm(dir, { recursive: true, force: true });
  });
});

function userAgent(): { readonly ecdh: ECDH; readonly auth: Buffer } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16) };
}

/** The user agent's side of RFC 8291: one aes128gcm record back to text. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body.readUInt8(20);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asPublic = body.subarray(21, 21 + idlen), record = body.subarray(21 + idlen);
  const hkdf = (ikm: Buffer, s: Buffer, info: string | Buffer, n: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, s, info, n));
  const ikm = hkdf(ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
  const decipher = createDecipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12));
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  return plain.subarray(0, -1).toString('utf8');
}

/** Verifies an ES256 JWT against a raw public point and returns its claims. */
function checkJwt(jwt: string, publicKey: string): unknown {
  const [header, claims, signature] = jwt.split('.');
  assert.ok(header && claims && signature);
  assert.deepEqual(JSON.parse(b64(header).toString()), { typ: 'JWT', alg: 'ES256' });
  const point = b64(publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, b64(signature)));
  return JSON.parse(b64(claims).toString());
}

function createPrivateKeyOf(text: string): KeyObject {
  const jwk: unknown = JSON.parse(text);
  assert.ok(isRecord(jwk) && typeof jwk.x === 'string' && typeof jwk.y === 'string' && typeof jwk.d === 'string');
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
}

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'pi-durable-push-'));
const paths = (dir: string) => ({ serveDir: join(dir, 'serve'), vapid: join(dir, 'serve', 'vapid.json'), push: join(dir, 'serve', 'push.json') });
