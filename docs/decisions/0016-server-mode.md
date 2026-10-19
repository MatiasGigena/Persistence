# 0016. Server mode: one headless host that clients attach to

## Status

Proposed, 2026-10-19. Amends [0008](0008-one-writer.md) and [0012](0012-terminal-ui.md).

## Context

The host runs in tmux on a VPS, and is reached from a phone over SSH or mosh. It stops when tmux or the machine
does, and only one terminal can show the chat at a time. The owner wants the chat to run around the clock, to be
reached from a phone's browser and a laptop, and still from a shell on the VPS. The one-writer rule
([0008](0008-one-writer.md)) allows one process per database, and the UI already reaches the host only through the
`UiSession` contract ([0012](0012-terminal-ui.md)).

## Decision

- `pi-durable serve [--cwd D] [--port N]` runs the host headless under the database's flock, as a systemd user
  service. It opens the instance, resumes pending work, and serves one `createUiSession()` to every client.
- The server's only API is the `UiSession`, carried by the wire protocol ([0017](0017-wire-protocol.md),
  [docs/protocol.md](../protocol.md)) over two transports: a mode 600 Unix socket beside the database
  (`<db>.sock`), and a WebSocket on loopback TCP for the web app behind `tailscale serve`
  ([0019](0019-private-access.md)).
- Inside the server: `hub.ts` fans the session out (status, the root feed, agent feeds opened by refcount, notices,
  push triggers); `connection.ts` holds one peer's sync state and requests; `transport-unix.ts` and
  `transport-ws.ts` frame messages.
- An interactive launch probes the socket and attaches when a server answers ([0018](0018-tui-attach.md)): no flock,
  no instance. `--local` skips the probe; `--attach` fails without a server.
- `serve pair`, `serve devices [--revoke NAME]` and `backup` talk to the running server over its socket
  (`admin.*` ops). `backup` without a server takes the flock itself ([0022](0022-online-backups.md)).
- All state paths come from one function, `statePaths()` in `src/host/config.ts`: the socket (or
  `$XDG_RUNTIME_DIR/pi-durable-<hash>.sock` when `<db>.sock` is over 107 bytes; never `/tmp`), and `serve/`
  beside the database with `vapid.json`, `push.json` and `devices.json`, mode 600.

## Consequences

- The one-writer rule holds: the server is the writer. Clients write nothing; they ask the server.
- While a server runs, one-shot launches (`-p`, `--status`, `--history`, `--resume`) still need the flock and exit
  with 75, until they too go over the socket (plan phase 7).
- "No daemon and no listener" now holds only without `serve`. With it there is a listener, never on a public
  address (AGENTS.md invariant).
- The terminal UI can run remote: `memoryView` and `zoom` became async and `onNotice` was added to the contract.
- `serve/` sits beside the database, like `settings.json`: with the default layout that is the data dir, as the
  plan says; with `--database` it follows the database.
