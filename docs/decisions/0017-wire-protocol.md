# 0017. Wire protocol: JSON messages, state synced by item id diffs

## Status

Accepted, 2026-10-19; implemented in `src/protocol/`.

## Context

A server ([0016](0016-server-mode.md)) must carry one `UiSession` to an attached terminal UI and to a browser on a
phone. The session is a list of `ChatItem`s per conversation that change in place while a reply streams, a status
object, and a dozen request methods. Phones drop and resume connections often, and read slowly over mobile links.

Options considered:

- **Chord's WebSocket links**, which pi-durable is built on. The browser would need Chord and TypeBox, and the
  object model a link exposes (replicated documents, attached states, contexts) is much larger than one
  `UiSession`. Clients would depend on pi-durable's internals, which the TUI deliberately does not
  ([0012](0012-terminal-ui.md)).
- **Forwarding pi-durable's agent events** and folding them in each client. Every client would repeat
  `src/ui/feed.ts`, and a slow client would need every event queued.
- **JSON Patch** on the item list: general, but larger, and an index-based path breaks when the 200-item cap
  shifts the list.

## Decision

- Protocol v1, specified in [docs/protocol.md](../protocol.md), typed and parsed in `src/protocol/` (shared by Node
  and the browser; no Node or DOM imports). One JSON message per WebSocket frame, NDJSON on the Unix socket.
- Client → server: `hello`, `req {id, op, params}`, `visible`, `ping`. Server → client: `welcome`, `ready`,
  `status`, `snapshot`, `items {ops}`, `feed.end`, `notice`, `res`, `pong`, and `bye` before it closes.
- State is synced, not streamed: the server keeps what it last sent each peer, and sends the difference by item id
  (`diffItems`): `put` (with `before` for an insertion), `append {id, field, at, text}` for streamed text, `del`.
  When the items both lists hold change order, it sends a snapshot. The client applies ops with `applyOps`, and
  asks `feed.resync` when one does not fit.
- Tool output and arguments are clipped on the wire at 64 Ki code units, head and tail kept.
- Backpressure syncs state rather than queueing events: flushes every 50 ms at most, skipped while 256 KiB are
  unsent; a peer above 8 MiB unsent for 60 s is closed with 4008.
- No resumption: every connection gets `welcome` and full snapshots. `send` takes an optional `requestId`, which
  the server passes to pi-durable's submission dedup, so a resend after a lost `res` is admitted once.
- Additive changes keep `PROTOCOL`; receivers ignore unknown message types and fields. Removals, renames, and new
  item kinds or item ops bump it.

## Consequences

- A client is small: a parser, `applyOps`, and a request table. The browser imports the same files the server does.
- A slow or sleeping phone costs the server one item list per feed, not a queue.
- Diffs are computed per peer at each flush: at most 200 items per feed, compared by object identity first.
- A reordering in the feed (rare: it appends, and updates in place) costs a snapshot.
- Changes to the plan's draft, made while freezing it: `put.before` (insertions without snapshots), `bye` (close
  codes on the socket too), `op` in a successful `res` (results can be checked), `send.requestId`, and
  `admin.devices`/`admin.revoke` (so revocation can close live connections).
