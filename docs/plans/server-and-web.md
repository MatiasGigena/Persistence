# Plan: server mode and the phone web app

Status: in progress (2026-10-19). This is the working spec for the build; each phase
ends in ADRs and docs that replace the relevant part of this file.

## Owner decisions

- The host runs 24/7 on the owner's VPS as a systemd **user** service.
- Access is over **Tailscale** only: `tailscale serve` gives HTTPS on the tailnet
  (MagicDNS name in certificate logs is accepted). The phone is on the tailnet.
- Logins (`claude auth login`, Pi `/login`) are done on the VPS.
- Tools work in `~/projects` (`serve --cwd ~/projects`).
- Coding tools may be turned on from the phone, with a confirmation, and turn
  themselves off after **30 idle minutes**. The server always starts with tools off.
- Backups: daily on the VPS only, kept 14 days.
- Phone OS not fixed: the web app and Web Push must work on iOS (home-screen app,
  16.4+) and Android.

## Architecture

```
 phone (PWA)            laptop browser           VPS shell (ssh/mosh)
     │ HTTPS/WSS (tailnet only)  │                     │ pi-durable (TUI client)
     ▼                           ▼                     │
 tailscale serve :443 ──► 127.0.0.1:7433               │ cli.ts probes <db>.sock
 (adds Tailscale-User-Login)     │                     │ ok → attach, no flock
                                 ▼                     ▼
 ┌──────── pi-durable serve (systemd --user, holds flock <db>.lock) ─────────┐
 │ transport-ws.ts (ws, Origin+auth, static.ts)  transport-unix.ts (NDJSON)  │
 │        └──────────► connection.ts (per peer: diff outbox, requests) ◄──┘   │
 │                    hub.ts (fan-out, agent-feed refcounts, push triggers)  │
 │                    createUiSession()  →  Instance (Harness, memory, agents)│
 └──────────── chat.sqlite · chat.unii/ · settings.json · serve/ ────────────┘
 no server running: cli.ts → flock → host.ts → in-process TUI (today's path)
```

## Layout

| Path | Contents |
|---|---|
| `src/protocol/` | Shared by Node and the browser; no DOM or Node imports. `version.ts`, `messages.ts`, `parse.ts` (parse `unknown`, narrow), `diff.ts` (`diffItems`), `mirror.ts` (`applyOps`) |
| `src/server/` | `serve.ts`, `hub.ts`, `connection.ts`, `transport-unix.ts`, `transport-ws.ts`, `static.ts`, `auth.ts`, `push.ts`, `store.ts`, `backup.ts` |
| `src/client/` | `remote-session.ts` (a `UiSession` over a link), `unix-link.ts`, `attach.ts` |
| `src/web/` | `index.html`, `manifest.webmanifest`, `icons/`, `styles.css`, `main.ts`, `link.ts`, `store.ts`, `chat-view.ts`, `markdown.ts`, `panels/*`, `push.ts`, `sw.ts`; own `tsconfig.json` (lib DOM) and `sw/tsconfig.json` (WebWorker) |
| `contrib/systemd/` | `pi-durable.service`, `pi-durable-backup.{service,timer}` |
| state | `<db>.sock` (falls back to `$XDG_RUNTIME_DIR` if the path is over 107 bytes); `<data dir>/serve/{vapid.json,push.json,devices.json}`, mode 600 |

## Decisions fixed in phase 0

- **`UiSession` changes:** `zoom` and `memoryView` become async; add
  `onNotice(listener)`; `TuiInfo.attached` (state, onChange) makes exit mean
  "detach".
- **Wire protocol v1**, JSON:
  - one message per WebSocket frame, NDJSON on the Unix socket
  - client → server: `hello`, `req{id,op,…}`, `visible`, `ping`
  - server → client: `welcome`, `ready`, `status`, `snapshot`, `items{ops}`,
    `feed.end`, `notice`, `res`, `pong`, `bye` (amended, below)
- **Item ops:** `put` (with `before` for an insertion, amended), `append{id,field,at,text}`,
  `del`. If the order changes, the server sends a snapshot instead.
- **Backpressure syncs state rather than queueing events:**
  - each peer keeps a `sent` map;
  - flush every ≤50 ms while the buffer is under 256 KiB;
  - close with 4008 if the buffer stays over 8 MiB for 60 s.
- **Ops:**
  - `send`, `abort`, `stopAgents`, `feed.open`/`feed.close`/`feed.resync`
  - `memory.view`, `memory.zoom`, `models`, `model.set`
  - `tools.set{enabled, confirm:'enable-tools'}`
  - `push.subscribe`/`push.unsubscribe`
  - socket only: `admin.backup`, `admin.pair`, `admin.devices`, `admin.revoke` (amended)
- **Error codes:** `bad_request`, `unknown_op`, `not_found`, `forbidden`, `failed`,
  `unavailable`, `version`.
- **Close codes:** 4000 version, 4001 unauthorized, 4008 too slow, 1012 restart.
- **Resume:** a fresh welcome and snapshot on every reconnect. A changed `boot` or
  `assets` value tells the web app to reload.
- **Versioning:** additive changes don't bump `PROTOCOL`; removals and renames do.
- **CLI:**
  - `pi-durable serve [--cwd D] [--port 7433]` (refuses `--allow-tools`)
  - `serve pair`, `serve devices [--revoke NAME]`, `backup [--out DIR]`
  - interactive launches probe `<db>.sock` and attach; `--local` skips the probe;
    `--attach` requires a server
- **Auth, all of these together:**
  - bind to loopback only;
  - `Tailscale-User-Login` must be in `PI_DURABLE_ALLOW_LOGIN`;
  - device pairing with a one-time code gives an `HttpOnly; Secure; SameSite=Strict`
    `pd_device` cookie (only its sha256 is stored);
  - `Origin` must equal `PI_DURABLE_ORIGIN`.
- **Tools policy:**
  - `PI_DURABLE_REMOTE_TOOLS=confirm|off` (default `confirm`);
  - `PI_DURABLE_TOOLS_IDLE_MIN` (default 30) turns tools off after that many idle
    minutes;
  - each change is broadcast as a notice and written to the journal.
- **Environment:** `PI_DURABLE_ORIGIN`, `PI_DURABLE_ALLOW_LOGIN`, `PI_DURABLE_PORT`,
  `PI_DURABLE_REMOTE_TOOLS`, `PI_DURABLE_TOOLS_IDLE_MIN`, `PI_DURABLE_PUSH_PREVIEW`.
- **Web client:** no build. The server strips TypeScript at request time with
  `node:module` `stripTypeScriptTypes`, the DOM code is vanilla, `marked` is
  vendored from node_modules, and a strict CSP applies.
- **Push:** Web Push with VAPID keys and aes128gcm encryption on `node:crypto` (no
  `web-push` package). It fires when Pi finishes a run or an agent reports while no
  client is visible.
- **Backups:** `VACUUM INTO`, then copy `.unii`. A daily timer keeps 14 days.

### Amended while freezing (phase 0)

The contract is now [docs/protocol.md](../protocol.md) and `src/protocol/`; ADRs 0016 to 0022 (proposed) record
the decisions. Changes to the list above, and why:

- **`put.before`.** A new item may be inserted before an existing one (`before: id`), else it goes at the end.
  The feed is `committed + live`: a retry notice or a tool result committed while a reply streams lands before the
  live items, which would otherwise cost a snapshot each time. Moving an existing item still means a snapshot.
- **`bye {code, reason}`** is the server's last message on both transports. NDJSON has no close frame, and the
  attached TUI must tell "restarting" (reconnect) from "wrong version" or "revoked" (stop).
- **A successful `res` carries `op`**, so the client's parser can check the result's shape; a failed one carries
  `error {code, message}`, with `id` -1 when the request's id was unreadable.
- **`send` takes an optional `requestId`**, passed to pi-durable's submission dedup: a client that lost a `send`'s
  `res` to a reconnect can resend it without Pi getting the message twice.
- **`admin.devices` and `admin.revoke`**: `serve devices --revoke` must close the device's live connections,
  which only the server can do; so device admin goes over the socket like `admin.pair`.
- **`welcome`** is fixed as `protocol, server, boot, assets, peer, cwd, tools {remote, idleMinutes}, pushKey?,
  device?`. `cwd` is for the attached TUI's path completion; `tools` lets a client grey out what the policy forbids.
- **The `version` error code** answers a request sent before `hello`.
- **Clipping** covers a tool's `args` as well as its `output` (a `write` carries the whole file in its arguments),
  at 64 Ki UTF-16 code units, head and tail kept.
- **`src/ui/types.ts` imports nothing.** The status's agents are `AgentStatus` (no conversation ID) and its memory
  `MemoryStats`, defined there, so the browser's tsconfig resolves the contract without Node types.
- **The socket fallback** is `$XDG_RUNTIME_DIR` only, never `/tmp` (another user could squat the name). Without
  it, a path over 107 bytes has no socket: `serve` refuses, and interactive launches do not probe. A client
  checks the socket's owner before connecting.
- **`serve/`** sits beside the database, like `settings.json`: the data dir by default, as written above.
- **CLI:** a first word `serve` or `backup` is the command, so such a prompt needs `-p` or `--`. `--attach`
  refuses launch settings (`--allow-tools`, `--model`, `--thinking`, `--cwd`, `--auth-file`, `--plain`) and one-shot
  modes; a probed attach (phase 3) refuses the same settings with an error rather than silently ignoring them.
  `--port` beats `PI_DURABLE_PORT`. Without `PI_DURABLE_ORIGIN` and `PI_DURABLE_ALLOW_LOGIN`, `serve` runs socket only.
- **`PI_DURABLE_PUSH_PREVIEW`** is `on` or `off`, default `off`: nothing of the chat on a lock screen unless asked.
- **Backups:** the `VACUUM INTO` and the `.unii` copy run in one synchronous step of the writer, so no commit or
  memory append lands between them.

## Phases

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 | Contract changes, `src/protocol/*` with tests, `docs/protocol.md`, CLI/config surface, ADR drafts (done) | — |
| 2 | Headless `serve`: hub, Unix socket, systemd unit, idle tools-off, `backup`, ops docs | 0 |
| 3 | `RemoteSession` and CLI attach | 0 (integrates with 2) |
| 4 | WebSocket transport, static server, auth/pairing, Tailscale docs; web MVP | 0, 2 |
| 5 | Web agents, memory, models, tools; PWA and service worker | 4 |
| 6 | Push: crypto, subscribe UI, service worker handler, hub triggers | 0 (crypto), 5 (UI) |
| 7 | Optional: `-p`/`--status` over the socket, Playwright, `--attach https://` | 3, 4 |

(Phase 1, the narrow-terminal TUI, shipped as ADR 0014.)
