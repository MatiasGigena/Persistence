// Private access for web peers (docs/protocol.md "Web peers", ADR 0019): the Tailscale login allow-list, the
// Origin check, and paired devices with their one-time pairing codes and `pd_device` cookies.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Device } from '../protocol/messages.ts';
import type { DeviceRegistry } from './link.ts';
import { array, number, optionalNumber, readJson, record, string, writeJson } from './store.ts';
import { ShapeError } from '../protocol/util.ts';

export const COOKIE = 'pd_device';
/** 400 days: the longest cookie lifetime browsers keep. */
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
export const PAIR_CODE_MS = 5 * 60_000;
/** Wrong codes that spend a pairing code. */
export const PAIR_TRIES = 5;
/** `lastSeen` is written to devices.json at most this often per device. */
export const LAST_SEEN_MS = 10 * 60_000;
export const DEVICE_NAME_MAX = 40;
/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A device as devices.json stores it: the cookie's sha256 (hex), never the cookie. */
interface StoredDevice extends Device {
  readonly hash: string;
}

/** Why `redeem` refused: 400 `malformed`, 401 `wrong` (a wrong, spent or expired code), 409 `taken`. */
export type RedeemError = 'malformed' | 'wrong' | 'taken';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const publicDevice = ({ name, pairedAt, lastSeen }: StoredDevice): Device =>
  lastSeen === undefined ? { name, pairedAt } : { name, pairedAt, lastSeen };

/** A device name: 1 to 40 characters after trimming, no control characters; undefined otherwise. */
export function deviceName(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const name = x.trim();
  return name.length >= 1 && name.length <= DEVICE_NAME_MAX && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : undefined;
}

/** A typed code as the 8 canonical characters: case, dashes and spaces ignored, I and L read as 1, O as 0. */
export function normalizeCode(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const code = x.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return code.length === CODE_LENGTH && [...code].every(c => ALPHABET.includes(c)) ? code : undefined;
}

/** devices.json: `{"devices": [{name, hash, pairedAt, lastSeen?}]}`. Throws a ShapeError naming the field. */
function parseDevices(value: unknown): StoredDevice[] {
  return array(record(value, 'devices.json'), 'devices', (item, i) => {
    const d = record(item, `devices[${i}]`);
    const device = { name: string(d, 'name'), hash: string(d, 'hash'), pairedAt: number(d, 'pairedAt') };
    if (!/^[0-9a-f]{64}$/.test(device.hash)) throw new ShapeError(`devices[${i}].hash must be a sha256 in hex`);
    const lastSeen = optionalNumber(d, 'lastSeen');
    return lastSeen === undefined ? device : { ...device, lastSeen };
  });
}

/**
 * The paired web devices, kept in `serve/devices.json` (mode 600, in a mode 700 directory), and the one pending
 * pairing code (in memory only: a server restart forgets it). One instance per server: the hub serves the admin
 * ops from it, and the web listener checks cookies and redeems codes against it.
 */
export class Devices implements DeviceRegistry {
  readonly path: string;
  readonly #now: () => number;
  #devices: StoredDevice[];
  #pending: { code: string; expiresAt: number; tries: number } | undefined;

  private constructor(path: string, devices: StoredDevice[], now: () => number) {
    this.path = path;
    this.#devices = devices;
    this.#now = now;
  }

  /** Reads `path` (absent: no devices). Rejects, naming the file, when it is not a device list. `now` is for tests. */
  static async open(path: string, now: () => number = Date.now): Promise<Devices> {
    return new Devices(path, await readJson(path, parseDevices, () => []), now);
  }

  /** A new one-time code, shown as XXXX-XXXX; it replaces any code still pending. */
  pair(): Promise<{ readonly code: string; readonly expiresAt: number }> {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('');
    const expiresAt = this.#now() + PAIR_CODE_MS;
    this.#pending = { code, expiresAt, tries: 0 };
    return Promise.resolve({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt });
  }

  list(): Promise<readonly Device[]> {
    return Promise.resolve(this.#devices.map(publicDevice));
  }

  revoke(name: string): Promise<boolean> {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter(device => device.name !== name);
    if (this.#devices.length === before) return Promise.resolve(false);
    this.#save();
    return Promise.resolve(true);
  }

  /**
   * Pairs a device: on the pending code, returns the new cookie value (32 random bytes, base64url), of which only
   * the sha256 is stored. A wrong code counts against the code's tries; a taken name leaves the code unspent.
   */
  redeem(code: unknown, name: unknown): { readonly cookie: string; readonly device: Device } | { readonly error: RedeemError } {
    const typed = normalizeCode(code), label = deviceName(name);
    if (typed === undefined || label === undefined) return { error: 'malformed' };
    const pending = this.#pending;
    if (!pending || pending.expiresAt <= this.#now() || pending.tries >= PAIR_TRIES) {
      this.#pending = undefined;
      return { error: 'wrong' };
    }
    if (!timingSafeEqual(Buffer.from(typed), Buffer.from(pending.code))) {
      if (++pending.tries >= PAIR_TRIES) this.#pending = undefined;
      return { error: 'wrong' };
    }
    if (this.#devices.some(device => device.name === label)) return { error: 'taken' };
    this.#pending = undefined;
    const cookie = randomBytes(32).toString('base64url');
    const device: StoredDevice = { name: label, hash: sha256(cookie), pairedAt: this.#now() };
    this.#devices = [...this.#devices, device];
    this.#save();
    return { cookie, device: publicDevice(device) };
  }

  /** The device whose cookie this is, its `lastSeen` refreshed (written at most every LAST_SEEN_MS). */
  verify(cookie: string): Device | undefined {
    if (!TOKEN.test(cookie)) return undefined;
    const hash = Buffer.from(sha256(cookie));
    // Compare every stored hash in constant time, rather than a map lookup keyed by the secret's hash.
    const index = this.#devices.findIndex(device => timingSafeEqual(Buffer.from(device.hash), hash));
    const device = this.#devices[index];
    if (!device) return undefined;
    const now = this.#now();
    if (device.lastSeen !== undefined && now - device.lastSeen < LAST_SEEN_MS) return publicDevice(device);
    const seen = { ...device, lastSeen: now };
    this.#devices = this.#devices.map((d, i) => i === index ? seen : d);
    this.#save();
    return publicDevice(seen);
  }

  #save(): void {
    writeJson(this.path, { devices: this.#devices });
  }
}

/** What the web listener checks requests against: ServeSettings with the web listener's two settings set. */
export interface Access {
  readonly origin: string;
  readonly allowLogins: readonly string[];
}

/** Why a request was refused: `login` and `origin` answer 403, `unpaired` 401. */
export type AuthReason = 'login' | 'origin' | 'unpaired';
export type Refusal = { readonly ok: false; readonly status: 401 | 403; readonly reason: AuthReason };
/** Checks 1 and 2 passed. */
export type Gate = { readonly ok: true; readonly login: string } | Refusal;
/** All three checks passed: the request comes from this device. */
export type AuthResult = { readonly ok: true; readonly login: string; readonly device: Device } | Refusal;

/** The parts of a request the checks read. */
export type RequestHead = { readonly method?: string | undefined; readonly headers: IncomingHttpHeaders };

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
};

/** The Origin check applies to the WebSocket upgrade and to every method but GET and HEAD. */
const needsOrigin = (request: RequestHead): boolean =>
  !(request.method === 'GET' || request.method === 'HEAD') || header(request.headers, 'upgrade') !== undefined;

/**
 * Checks 1 (login) and 2 (Origin, when the request needs it). `Tailscale-User-Login` is trusted only because the
 * listener is loopback-only behind `tailscale serve`, and only for this allow-list: never as an identity.
 */
export function gate(request: RequestHead, access: Access): Gate {
  const login = header(request.headers, 'tailscale-user-login');
  if (login === undefined || !access.allowLogins.includes(login)) return { ok: false, status: 403, reason: 'login' };
  if (needsOrigin(request) && header(request.headers, 'origin') !== access.origin) return { ok: false, status: 403, reason: 'origin' };
  return { ok: true, login };
}

/** The `pd_device` cookie values of a `Cookie` header. */
export function deviceCookies(headers: IncomingHttpHeaders): string[] {
  return (header(headers, 'cookie') ?? '').split(';').map(pair => pair.trim())
    .filter(pair => pair.startsWith(`${COOKIE}=`)).map(pair => pair.slice(COOKIE.length + 1));
}

/** Checks 1, 2 and 3: the login, the Origin when needed, and a paired device's cookie. */
export function authenticate(request: RequestHead, access: Access, devices: Devices): AuthResult {
  const passed = gate(request, access);
  if (!passed.ok) return passed;
  for (const cookie of deviceCookies(request.headers)) {
    const device = devices.verify(cookie);
    if (device) return { ok: true, login: passed.login, device };
  }
  return { ok: false, status: 401, reason: 'unpaired' };
}

/** The `Set-Cookie` value that pairs a browser. */
export const setCookie = (cookie: string): string =>
  `${COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
