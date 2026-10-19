// Web Push for this device: subscribes with the server's VAPID key (`welcome.pushKey`) only after a tap, and hands
// the subscription to the server (`push.subscribe`). iOS allows push only to a Home Screen app.
import { base64UrlBytes } from './format.ts';
import type { Link } from './link.ts';
import type { PushSubscriptionJson } from '../protocol/messages.ts';

/**
 * - `unsupported`: this browser has no Web Push.
 * - `install`: iOS outside a Home Screen app.
 * - `no-key`: the server has push off (no `pushKey`).
 * - `denied`: the user blocked notifications for this site.
 * - `off`, `on`: whether this device is subscribed.
 */
export type PushState = 'unsupported' | 'install' | 'no-key' | 'denied' | 'off' | 'on';

export const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
export const isStandalone = (): boolean => matchMedia('(display-mode: standalone)').matches;

const supported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushState(key: string | undefined): Promise<PushState> {
  if (isIos() && !isStandalone()) return 'install';
  if (!supported()) return 'unsupported';
  if (!key) return 'no-key';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && await subscription() ? 'on' : 'off';
}

/** The subscription as `push.subscribe` takes it. */
function asJson(sub: PushSubscription): PushSubscriptionJson {
  const json = sub.toJSON();
  const p256dh = json.keys?.['p256dh'], auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) throw new Error('The browser gave an incomplete push subscription.');
  return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh, auth } };
}

const sameKey = (sub: PushSubscription, key: Uint8Array): boolean => {
  const current = sub.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
};

/**
 * Turns notifications on. Call it straight from a tap: the permission prompt must follow a user gesture (iOS).
 * Rejects with a readable message when the user declines or the browser refuses.
 */
export async function enablePush(link: Link, key: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in the browser settings.');
  const registration = await navigator.serviceWorker.ready;
  const serverKey = base64UrlBytes(key);
  let sub = await registration.pushManager.getSubscription();
  if (sub && !sameKey(sub, serverKey)) { await sub.unsubscribe(); sub = null; }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await link.request('push.subscribe', { subscription: asJson(sub) });
}

/** Turns notifications off for this device, here and on the server. */
export async function disablePush(link: Link): Promise<void> {
  const sub = await subscription();
  if (!sub) return;
  await link.request('push.unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

/**
 * After each connection: hands an existing subscription to the server again (it replaces one with the same
 * endpoint), so a subscription the browser renewed, or the server lost, keeps working. A subscription made with
 * another key (the server's VAPID key changed) is renewed, which needs no prompt once permission is granted.
 */
export async function syncPush(link: Link, key: string | undefined): Promise<void> {
  if (!key || !supported() || Notification.permission !== 'granted') return;
  const sub = await subscription();
  if (!sub) return;
  if (sameKey(sub, base64UrlBytes(key))) await link.request('push.subscribe', { subscription: asJson(sub) });
  else await enablePush(link, key);
}
