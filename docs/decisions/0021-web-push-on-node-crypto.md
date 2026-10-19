# 0021. Web Push on node:crypto

## Status

Proposed, 2026-10-19.

## Context

The point of a phone client is to hear when Pi has answered or an agent has reported, without keeping the app
open. Web Push works on Android and on iOS 16.4+ (for home-screen apps). It needs VAPID (an ES256-signed JWT,
RFC 8292) and payload encryption (aes128gcm, RFC 8291). The `web-push` package does both, with dependencies; Node's
`crypto` has ECDH on P-256, HKDF, AES-128-GCM and ES256 signing.

## Decision

- `src/server/push.ts` implements VAPID and aes128gcm on `node:crypto`; no `web-push` package.
- The VAPID key pair is generated on first use and kept in `serve/vapid.json` (mode 600); the public key goes to
  web clients in `welcome.pushKey`.
- Subscriptions arrive with `push.subscribe` and are kept per device in `serve/push.json`; a push service answer
  of 404 or 410 removes one.
- The hub pushes when Pi finishes a run or an agent reports, and only while no client is `visible`.
- `PI_DURABLE_PUSH_PREVIEW=on` puts the reply's first words in the notification; the default `off` says only that
  Pi answered or which agent reported, so nothing of the chat shows on a lock screen or passes the push service.

## Consequences

- About 150 lines of crypto to own, tested against the RFCs' example vectors.
- Push needs the HTTPS origin (`PI_DURABLE_ORIGIN`) and, on iOS, the app installed to the home screen.
- With previews off, a notification carries no content: the app shows it after opening.
