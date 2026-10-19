// The seams inside the server: a transport hands each peer to the hub as a PeerLink, and the hub
// tells an optional PushNotifier when the owner should hear about something. See docs/protocol.md.
import type { CloseCode, Device, Peer, PushSubscriptionJson } from '../protocol/messages.ts';

/** One connected client, whatever carries it (Unix socket NDJSON or a WebSocket). */
export interface PeerLink {
  readonly peer: Peer;
  /** Who is on the other end, for notices and the journal: e.g. "socket" or "alice@example.com/phone". */
  readonly who: string;
  /** The paired device, for web peers. */
  readonly device?: Device;
  /** Sends one already-serialized protocol message (one frame, or one NDJSON line). */
  send(text: string): void;
  /** Bytes queued and not yet written: the hub flushes only while this stays under LIMITS. */
  buffered(): number;
  /** Closes the link; for NDJSON the transport sends `bye` with the code first. */
  close(code: CloseCode, reason: string): void;
  /** Each incoming message, as text. Called once; the transport delivers in order. */
  onMessage(listener: (text: string) => void): void;
  /** The link is gone (closed by either side). Called once. */
  onClose(listener: () => void): void;
}

/** The hub as transports see it. */
export interface PeerHub {
  /** Starts the protocol on a new link: waits for `hello`, then `welcome`, `status` and the root snapshot. */
  attach(link: PeerLink): void;
  /** Closes every link of one device (after a revoke). */
  closeDevice(name: string, code: CloseCode, reason: string): void;
}

/** Paired web devices: implemented by src/server/auth.ts; the hub serves the socket-only admin ops from it. */
export interface DeviceRegistry {
  /** A one-time pairing code, valid until `expiresAt` (ms). */
  pair(): Promise<{ readonly code: string; readonly expiresAt: number }>;
  list(): Promise<readonly Device[]>;
  /** Forgets the device; false when no device has that name. The hub then closes its links. */
  revoke(name: string): Promise<boolean>;
}

/** What the hub asks of push: implemented by src/server/push.ts, absent when push is off. */
export interface PushNotifier {
  /** The VAPID public key (base64url, uncompressed P-256 point) sent in `welcome.pushKey`. */
  readonly publicKey: string;
  subscribe(subscription: PushSubscriptionJson, device: string | undefined): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  /**
   * Sends to every subscription. `tag` replaces an earlier notification with the same tag. Never rejects:
   * failures are logged, and gone subscriptions (404/410) are dropped.
   */
  notify(message: { readonly title: string; readonly body: string; readonly tag: string }): Promise<void>;
}
