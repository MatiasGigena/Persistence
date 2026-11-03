// Web Push on node:crypto (ADR 0021): VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291 over RFC 8188).
// The VAPID key pair lives in serve/vapid.json and the subscriptions in serve/push.json, both mode 600 and written
// only by the server under the chat's flock. The hub decides when to push and what the message says.
import { createCipheriv, createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { ECDH, KeyObject } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServeSettings, StatePaths } from '../host/config.ts';
import { errorMessage, isObject } from '../memory/util.ts';
import type { PushSubscriptionJson } from '../protocol/messages.ts';
import type { PushNotifier } from './link.ts';
import { ShapeError, readJson, writeJson } from './store.ts';

/** RFC 8188 record size we announce; the whole payload is one record. */
const RECORD_SIZE = 4096;
/** Header (salt 16, rs 4, idlen 1, keyid 65) and the GCM tag: what a payload adds to the 4096 bytes services take. */
const OVERHEAD = 16 + 4 + 1 + 65 + 16;
/** Largest JSON payload: the body stays within 4096 bytes, the size RFC 8030 has every push service accept. */
export const MAX_PAYLOAD = 4096 - OVERHEAD - 1;
const KEY_INFO = Buffer.from('WebPush: info\0');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0');
/** RFC 8292 allows up to 24 h; 12 h leaves room for clock skew. */
const JWT_LIFETIME_S = 12 * 3600;
const TTL_S = 86400;
const MAX_RETRY_AFTER_MS = 60_000;
/** The wait before the one retry of a 429, a 5xx or a network failure that named no Retry-After. */
const DEFAULT_RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
/** Oldest subscriptions go beyond this many: a browser that resubscribes leaves its old endpoint behind. */
const MAX_SUBSCRIPTIONS = 32;
const MAX_ENDPOINT = 2048;

/** Push services we post to: exact hosts, and domains whose subdomains are allowed. */
const PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const PUSH_DOMAINS: readonly string[] = ['push.apple.com', 'notify.windows.com', 'push.services.mozilla.com'];

/**
 * The default endpoint check: https on the default port, no credentials, and a known push service's host. The
 * allowlist rules out IP literals, localhost and private names, so a forged subscription cannot aim the server's
 * POSTs at the tailnet or the machine itself (SSRF).
 */
export function isPushServiceEndpoint(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname;
  return PUSH_HOSTS.includes(host) || PUSH_DOMAINS.some(domain => host.endsWith(`.${domain}`));
}

/** A subscription `subscribe` refused; the hub answers `bad_request` with its message. */
export class InvalidSubscription extends Error {
  override name = 'InvalidSubscription';
}

export interface PushOptions {
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch: JWT expiry, `createdAt`, Retry-After dates. */
  readonly now?: () => number;
  /** One line per event worth the journal; default stderr. Endpoints are logged by origin only. */
  readonly log?: (line: string) => void;
  /** Which endpoints may be stored and posted to; default `isPushServiceEndpoint`. Tests allow a local server. */
  readonly allowEndpoint?: (url: URL) => boolean;
  /** The VAPID `sub` claim's address (`mailto:` is prepended). Default `pi-durable@<origin host>`. */
  readonly contact?: string;
}

/** `PushNotifier`, plus what device revocation needs. */
export interface PushService extends PushNotifier {
  /** Drops every subscription of a device (after `admin.revoke`); resolves how many there were. */
  forgetDevice(device: string): Promise<number>;
}

interface Stored {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly expirationTime?: number;
  readonly device?: string;
  readonly createdAt: number;
}

/**
 * Loads (or, on first use, generates) the VAPID key pair and the subscriptions. Rejects when a file is unreadable:
 * the server then runs without push. A newly generated key pair drops any stored subscription, since push
 * services refuse them under another key.
 */
export async function createPush(
  paths: Pick<StatePaths, 'serveDir' | 'vapid' | 'push'>,
  settings: Pick<ServeSettings, 'origin'>,
  options: PushOptions = {},
): Promise<PushService> {
  const post = options.fetch ?? fetch, now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => { console.error(`push: ${line}`); });
  const allow = options.allowEndpoint ?? isPushServiceEndpoint;
  const subject = `mailto:${options.contact ?? `pi-durable@${settings.origin ? new URL(settings.origin).hostname : 'localhost'}`}`;
  await mkdir(paths.serveDir, { recursive: true, mode: 0o700 });
  const [vapid, subs] = await Promise.all([loadVapid(paths.vapid), loadSubscriptions(paths.push, allow, log)]);
  const save = (): void => {
    writeJson(paths.push, { subscriptions: Object.fromEntries([...subs.values()].map(({ endpoint, ...entry }) => [endpoint, entry])) });
  };
  if (vapid.created && subs.size > 0) {
    log(`new VAPID keys: dropped ${subs.size} subscription(s) made under the old ones`);
    subs.clear();
    save();
  }
  const drop = (sub: Stored, why: string): void => {
    if (subs.get(sub.endpoint) !== sub) return;
    subs.delete(sub.endpoint);
    log(`dropped ${describe(sub)}: ${why}`);
    try { save(); } catch (error) { log(`could not save ${paths.push}: ${errorMessage(error)}`); }
  };

  async function deliver(sub: Stored, body: Buffer, topic: string): Promise<void> {
    const url = new URL(sub.endpoint);
    for (let attempt = 0; ; attempt++) {
      let status = 0, retryAfter: string | null = null, detail = '';
      try {
        const res = await post(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            TTL: String(TTL_S),
            Urgency: 'normal',
            Topic: topic,
            Authorization: `vapid t=${vapidJwt(vapid.key, url.origin, subject, now())}, k=${vapid.publicKey}`,
          },
          body,
        });
        if (res.ok) { await res.body?.cancel().catch(() => undefined); return; }
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        detail = (await res.text().catch(() => '')).slice(0, 200).trim();
      } catch (error) {
        detail = errorMessage(error);
      }
      if (status === 404 || status === 410) { drop(sub, `the push service answered ${status}`); return; }
      const transient = status === 0 || status === 429 || status >= 500;
      const wait = transient && attempt === 0 ? retryDelay(retryAfter, now()) : undefined;
      log(`${describe(sub)}: ${status ? `HTTP ${status}` : 'request failed'}${detail ? ` (${detail})` : ''}${wait === undefined ? '' : `; retrying in ${Math.ceil(wait / 1000)} s`}`);
      if (wait === undefined) return;
      await delay(wait);
    }
  }

  return {
    publicKey: vapid.publicKey,
    async subscribe(subscription, device) {
      const keys = checkSubscription(subscription, allow);
      const stored: Stored = {
        endpoint: subscription.endpoint, keys,
        ...typeof subscription.expirationTime === 'number' ? { expirationTime: subscription.expirationTime } : {},
        ...device === undefined ? {} : { device },
        createdAt: now(),
      };
      subs.delete(stored.endpoint);
      subs.set(stored.endpoint, stored);
      for (const endpoint of subs.keys()) {
        if (subs.size <= MAX_SUBSCRIPTIONS) break;
        subs.delete(endpoint);
      }
      save();
      log(`subscribed ${describe(stored)}`);
    },
    async unsubscribe(endpoint) {
      if (subs.delete(endpoint)) save();
    },
    async forgetDevice(device) {
      const gone = [...subs.values()].filter(sub => sub.device === device);
      for (const sub of gone) subs.delete(sub.endpoint);
      if (gone.length > 0) save();
      return gone.length;
    },
    async notify(message) {
      try {
        const payload = payloadOf(message), topic = topicOf(message.tag), at = now();
        const targets = [...subs.values()].filter(sub => {
          if (sub.expirationTime === undefined || sub.expirationTime > at) return true;
          drop(sub, 'expired');
          return false;
        });
        await eachLimit(targets, CONCURRENCY, async sub => {
          try {
            const keys = { p256dh: Buffer.from(sub.keys.p256dh, 'base64url'), auth: Buffer.from(sub.keys.auth, 'base64url') };
            await deliver(sub, encryptPayload(payload, keys.p256dh, keys.auth), topic);
          } catch (error) {
            log(`${describe(sub)}: ${errorMessage(error)}`);
          }
        });
      } catch (error) {
        log(`notify failed: ${errorMessage(error)}`);
      }
    },
  };
}

/**
 * RFC 8291 section 3 and RFC 8188: `plaintext` encrypted for the user agent's `uaPublic` (65-byte point) and
 * `authSecret` (16 bytes) as one aes128gcm record. `salt` and the ephemeral `ecdh` are fresh unless given (tests).
 */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, inject: { readonly salt?: Buffer; readonly ecdh?: ECDH } = {}): Buffer {
  if (plaintext.length > RECORD_SIZE - 16 - 1) throw new RangeError(`push payload of ${plaintext.length} bytes exceeds one record`);
  const salt = inject.salt ?? randomBytes(16);
  const ecdh = inject.ecdh ?? ephemeral();
  const asPublic = ecdh.getPublicKey();
  // PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HMAC(PRK_key, key_info || 0x01): one HKDF of 32 bytes.
  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, Buffer.concat([KEY_INFO, uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, CEK_INFO, 16), nonce = hkdf(ikm, salt, NONCE_INFO, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (and only) record's padding delimiter, with no padding after it.
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.of(2)])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

/** The RFC 8292 token: ES256 over `{typ, alg}.{aud, exp, sub}`, expiring 12 h after `nowMs`. */
export function vapidJwt(key: KeyObject, audience: string, subject: string, nowMs: number): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: subject })}`;
  return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** The service worker's payload: `{title, body, tag}` as UTF-8 JSON, the body cut to fit one push. */
function payloadOf(message: { readonly title: string; readonly body: string; readonly tag: string }): Buffer {
  const title = clip(message.title, 200), tag = clip(message.tag, 64);
  for (let body = clip(message.body, 1000); ; body = clip(body, Math.floor(body.length / 2))) {
    const json = Buffer.from(JSON.stringify({ title, body, tag }));
    if (json.length <= MAX_PAYLOAD || body === '') return json;
  }
}

/** `text` cut to `max` UTF-16 units, never inside a surrogate pair, with an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, '');
  return cut ? `${cut}…` : '';
}

/** RFC 8030's Topic: at most 32 base64url characters. Other tags are hashed, so distinct tags stay distinct. */
export function topicOf(tag: string): string {
  return /^[A-Za-z0-9_-]{1,32}$/.test(tag) ? tag : createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/** Milliseconds to wait before the one retry, or undefined when the service asks for more than a minute. */
function retryDelay(header: string | null, nowMs: number): number | undefined {
  let ms = DEFAULT_RETRY_MS;
  if (header !== null && /^\s*\d+\s*$/.test(header)) ms = Number(header) * 1000;
  else if (header !== null && !Number.isNaN(Date.parse(header))) ms = Math.max(0, Date.parse(header) - nowMs);
  return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/** The subscription's keys, decoded and checked; throws InvalidSubscription with the reason. */
function checkSubscription(subscription: PushSubscriptionJson, allow: (url: URL) => boolean): Stored['keys'] {
  const problem = subscriptionProblem(subscription, allow);
  if (problem) throw new InvalidSubscription(problem);
  return { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth };
}

function subscriptionProblem(sub: unknown, allow: (url: URL) => boolean): string | undefined {
  if (!isObject(sub) || typeof sub.endpoint !== 'string' || !isObject(sub.keys)) return 'a subscription needs endpoint and keys';
  if (sub.endpoint.length > MAX_ENDPOINT) return 'the endpoint is too long';
  let url: URL;
  try { url = new URL(sub.endpoint); } catch { return 'the endpoint is not a URL'; }
  if (!allow(url)) return 'the endpoint is not a known push service (https only)';
  if (sub.expirationTime !== undefined && sub.expirationTime !== null && typeof sub.expirationTime !== 'number') return 'expirationTime must be a number';
  const p256dh = base64url(sub.keys.p256dh), auth = base64url(sub.keys.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !isPoint(p256dh)) return 'keys.p256dh must be an uncompressed P-256 point';
  if (!auth || auth.length !== 16) return 'keys.auth must be 16 bytes';
  return undefined;
}

function isPoint(point: Buffer): boolean {
  try { ephemeral().computeSecret(point); return true; } catch { return false; }
}

/** Strict base64url (unpadded, as `PushSubscription.toJSON()` gives it). */
function base64url(value: unknown): Buffer | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, 'base64url') : undefined;
}

function ephemeral(): ECDH {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/** For the journal: the push service's origin and the device, never the endpoint's secret path. */
const describe = (sub: Stored): string => `${new URL(sub.endpoint).origin}${sub.device ? ` (${sub.device})` : ''}`;

async function eachLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The stored private JWK, or a new P-256 pair written as one (mode 600). */
async function loadVapid(file: string): Promise<{ readonly key: KeyObject; readonly publicKey: string; readonly created: boolean }> {
  const stored = await readJson(file, value => {
    const vapid = parseJwk(value);
    if (!vapid) throw new ShapeError('not a P-256 private key; deleting it makes new keys and drops every push subscription');
    return vapid;
  }, () => undefined);
  if (stored) return { ...stored, created: false };
  const vapid = parseJwk(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }));
  if (!vapid) throw new Error('node:crypto exported an unexpected P-256 key');
  writeJson(file, vapid.jwk);
  return { ...vapid, created: true };
}

/** A P-256 private JWK: the key, its public point as `welcome.pushKey` wants it, and the JWK's fields to store. */
function parseJwk(value: unknown): { readonly key: KeyObject; readonly publicKey: string; readonly jwk: object } | undefined {
  if (!isObject(value) || value.kty !== 'EC' || value.crv !== 'P-256') return undefined;
  const x = base64url(value.x), y = base64url(value.y), d = base64url(value.d);
  if (x?.length !== 32 || y?.length !== 32 || d?.length !== 32) return undefined;
  const jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url'), d: d.toString('base64url') };
  try {
    return { key: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: Buffer.concat([Buffer.of(4), x, y]).toString('base64url'), jwk };
  } catch { return undefined; }
}

/** push.json: `{subscriptions: {<endpoint>: {keys, expirationTime?, device?, createdAt}}}`; bad entries are skipped. */
async function loadSubscriptions(file: string, allow: (url: URL) => boolean, log: (line: string) => void): Promise<Map<string, Stored>> {
  const subs = new Map<string, Stored>();
  const entries = await readJson(file, value => {
    if (!isObject(value) || !isObject(value.subscriptions)) throw new ShapeError('subscriptions must be an object');
    return Object.entries(value.subscriptions);
  }, () => []);
  for (const [endpoint, entry] of entries) {
    if (!isObject(entry) || !isObject(entry.keys) || typeof entry.createdAt !== 'number'
      || (entry.device !== undefined && typeof entry.device !== 'string')
      || subscriptionProblem({ endpoint, keys: entry.keys, expirationTime: entry.expirationTime }, allow)) {
      log(`skipped an unreadable subscription in ${file}`);
      continue;
    }
    const { p256dh, auth } = entry.keys;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') continue;
    subs.set(endpoint, {
      endpoint, keys: { p256dh, auth }, createdAt: entry.createdAt,
      ...typeof entry.expirationTime === 'number' ? { expirationTime: entry.expirationTime } : {},
      ...typeof entry.device === 'string' ? { device: entry.device } : {},
    });
  }
  return subs;
}
