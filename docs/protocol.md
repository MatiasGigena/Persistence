# Wire protocol v3

The protocol between `pi-durable serve` and its clients: the terminal UI over a Unix socket or SSH stdio bridge,
and the web app over a WebSocket. It carries one `UiSession` ([src/ui/types.ts](../src/ui/types.ts)) across a link: the client
mirrors the chat items and the status, and calls the session's methods as requests.

This document is the reference. [src/protocol/](../src/protocol/) holds its types, constants, parser and sync code,
shared by Node and the browser; where the two differ, fix one of them. Decisions: ADRs
[0016](decisions/0016-server-mode.md), [0017](decisions/0017-wire-protocol.md),
[0018](decisions/0018-tui-attach.md), [0019](decisions/0019-private-access.md),
[0025](decisions/0025-protected-folders.md) and [0028](decisions/0028-remote-machines-over-ssh.md).

| File | Exports |
|---|---|
| `src/protocol/version.ts` | `PROTOCOL` |
| `src/protocol/messages.ts` | every message type, `Ops`/`Op`/`Params`/`Result`, `ItemOp`, `ErrorCode`, `CloseCode`, `LIMITS`, `ROOT_FEED`, `OPS`, `SOCKET_ONLY`, `WEB_ONLY`, `ENABLE_TOOLS` |
| `src/protocol/machines.ts` | `MachineRegistration`, `MachineCall`, `MachineCancel`, `MachineResult`, `MachineToolResult`, machine/JSON narrowing |
| `src/protocol/parse.ts` | `parseClientMessage`, `parseServerMessage`, `isParseError`, `ParseError`; `chatItem`, `sessionStatus`, `itemOp` |
| `src/protocol/diff.ts` | `diffItems`, `wireItem`, `clip` (server side) |
| `src/protocol/mirror.ts` | `applyOps` (client side) |

Names below are as in the code. "Code units" are JavaScript string length (UTF-16).

## Transports

Every message is one JSON object with a string field `t`, its type. Text is UTF-8.

| | Unix socket | WebSocket |
|---|---|---|
| Who | the attached TUI and the admin commands, on the VPS | the web app, through `tailscale serve` |
| Where | `statePaths(db).socket`: `<db>.sock`, or `$XDG_RUNTIME_DIR/pi-durable-<hash>.sock` when that is over 107 bytes | `ws://127.0.0.1:<port>/ws` (the browser sees `wss://<PI_DURABLE_ORIGIN host>/ws`) |
| Framing | NDJSON: one message per line, `\n`-terminated (JSON escapes newlines inside strings) | one message per text frame; a binary frame closes with 1003, a frame over 12 MiB (`3 × LIMITS.clientMessage` bytes, the most that many code units take in UTF-8) with 1009 |
| Auth | the socket file is mode 600 in the user's own directory | see [Authentication](#authentication) |
| `welcome.peer` | `socket` | `web` |

SSH adds no server listener: a noninteractive, strict-known-host `ssh -T` process
runs `pi-durable bridge`, which proxies these same NDJSON messages to the existing
owner-checked Unix socket. The peer remains `socket`. The bridge opens no database,
flock, model runtime or generic external MCP endpoint; no SSH forwarding is used.

- The server never listens elsewhere: not on a public address, not on `0.0.0.0`. See the invariant in AGENTS.md.
- Before connecting, a socket client checks that the socket is owned by its own uid, and refuses otherwise.
- A client message longer than `LIMITS.clientMessage` (4 Mi code units) is not parsed (on the socket, the line
  is skipped up to its newline). The server answers `bad_request` with `id` -1 and keeps the connection. On the
  WebSocket the transport answers it and does not hand it to the hub.
- Malformed messages (`parseClientMessage` returns a `ParseError`): with a readable request `id`, the server
  answers that id with `unknown_op` (for `invalid: 'unknown_op'`) or `bad_request`; an unknown `t` is ignored;
  anything else gets `bad_request` with `id` -1. None closes the connection.
- The socket/WebSocket protocol has no server-message size limit; clipping (below) limits individual tool
  outputs. The SSH transport additionally refuses an NDJSON line over 32 Mi code units and bounds its writes.

## Connection lifecycle

```
client                                         server
  │ hello {protocol:3, client, visible}  ─────►  │  (within LIMITS.helloMs, or bye 4000)
  │ ◄───── welcome {protocol, boot, assets, peer, cwd, tools, machines?, pushKey?, device?}
  │ ◄───── status {status}
  │ ◄───── snapshot {feed:"root", items}
  │ ◄───── ready
  │ req {id, op, params}  ───────────────────►   │
  │ ◄───── res {id, op, ok:true, result}  |  res {id, ok:false, error}
  │ ◄───── items {feed, ops} · status · notice · feed.end   (any time after ready)
  │ ping {n}  ───────────────────────────────►   │
  │ ◄───── pong {n}
  │ ◄───── bye {code, reason}, then the transport closes
```

1. The client sends `hello` first. If `hello.protocol` is not the server's `PROTOCOL`, the server sends
   `bye {code: 4000}` and closes. Without a valid `hello` within `LIMITS.helloMs` (10 s), the same.
2. Before `hello`, a `req` is answered with `res` error `version`; `visible` and `ping` are ignored.
3. The server answers with `welcome`, `status`, the root feed's `snapshot`, then `ready`. From `ready` on the
   client has the whole state, and the server sends changes as they happen. A server that is still starting (it
   listens as soon as the chat is open) sends `welcome` at once and the rest when its session is up; meanwhile
   every request but the `admin.*` ones gets `unavailable`.
4. The client may send requests any time after its `hello`. Each `req` gets exactly one `res` with the same `id`.
   Responses may come in any order; ids are the client's, and must not repeat while one is pending. At most 32
   requests may be pending on one connection; another gets `unavailable`.
5. Messages on one connection arrive in the order sent. A feed's `snapshot` precedes any `items` for it; the
   `res` of `feed.open` precedes that feed's first `snapshot`.
6. The client sends `ping {n}` at least every `LIMITS.pingMs` (25 s) while open (the attached TUI: every 20 s); the
   server answers `pong {n}`. A client that receives nothing for twice its ping interval treats the link as dead
   and reconnects. The server ends a connection that sent nothing for 60 s with `bye {code: 1000}`.
7. The server ends a connection by sending `bye {code, reason}`, then closing: on a WebSocket with a close frame
   of the same code, on the socket by ending it. A client detaches by closing (WebSocket code 1000).

## Authentication

### Socket peers

The socket is created mode 600 in the database's directory (mode 700), or in `$XDG_RUNTIME_DIR`. Whoever can
open it is the owner: no further check. Socket peers may call every op except `push.*`.

### Web peers

The web listener runs only when both `PI_DURABLE_ORIGIN` and `PI_DURABLE_ALLOW_LOGIN` are set; otherwise
`serve` is socket only and says so at start. It binds `127.0.0.1:<port>` (default 7433), and `tailscale serve`
proxies HTTPS on the tailnet to it. Every HTTP request, the WebSocket upgrade included, must pass all of:

1. **Login.** The `Tailscale-User-Login` header, which `tailscale serve` sets for the tailnet user, is in
   `PI_DURABLE_ALLOW_LOGIN` (comma-separated, exact match). Otherwise 403.
2. **Origin.** For the WebSocket upgrade and every request that is not `GET` or `HEAD`, the `Origin` header
   equals `PI_DURABLE_ORIGIN` exactly. Otherwise 403.
3. **Device.** The `pd_device` cookie's sha256 (hex) is in `serve/devices.json`. Otherwise 401. Exempt: the
   static app and `/api/pair`, so an unpaired browser can load the pairing screen and pair.

The header is trusted only because nothing but `tailscale serve` reaches the loopback port from outside, and only
for this allow-list: the server never uses it as an identity beyond naming the peer in notices (`who` is
`<login>/<device>`). A refused `/api/*` request or upgrade has the body `{"error":"login" | "origin" | "unpaired"}`.

A local user of the VPS can reach the loopback port and forge the login header, so the device cookie is what
stops them; the checks hold only together. The VPS is assumed to have one user.

| Endpoint | Checks | Answer |
|---|---|---|
| `GET /`, `GET /<app file>` | 1 | the web app; `.ts` files type-stripped to JavaScript; a strict CSP; 404 for any other path |
| `GET /api/me` | 1, 3 | 200 `{"device":"<name>"}`; 401 `{"error":"unpaired"}` |
| `POST /api/pair` | 1, 2 | body `{"code":"XXXX-XXXX","name":"<device name>"}` (at most 1 KiB) → 204 and the cookie; 400 malformed, 401 wrong, spent or expired code, 409 name taken, 429 over 10 tries a minute from one address (with `Retry-After`) |
| `GET /ws` (upgrade) | 1, 2, 3 | 101, then this protocol as a `web` peer; 403 or 401 without upgrading |

- The web app calls `/api/me` before opening `/ws`: a browser cannot read why an upgrade failed, and the app must
  tell "pair this device" from "offline".
- **App files** ([src/server/static.ts](../src/server/static.ts), ADR [0020](decisions/0020-web-client-without-build.md)):
  `src/web/` at `/` (`/` is `index.html`), `src/protocol/` at `/protocol/`, `src/ui/types.ts` at `/ui/types.ts`, and
  marked's ESM build at `/vendor/marked.esm.js` (with its source map). So `src/web/x.ts` imports
  `../protocol/messages.ts` as in the source tree, and `marked` through an import map in `index.html`. Served
  extensions: `.html .ts .js .css .json .map .webmanifest .svg .png .ico .woff2`; never dot-files or `tsconfig.json`.
  Every file has an ETag and `Cache-Control: no-cache` (nothing is content-hashed). Every response carries the CSP
  (`default-src 'self'`; `script-src 'self'` plus the sha256 of each inline `<script type="importmap">` in
  `index.html`, and no other inline script; `connect-src 'self'` and the origin's `wss:`; `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
  `welcome.assets` hashes every served file's path and bytes.
- **Pairing.** `pi-durable serve pair` calls `admin.pair` and prints a one-time code: 8 characters of Crockford
  base32, shown as `XXXX-XXXX`, valid 5 minutes, one use; 5 wrong tries spend it. One code is pending at a time:
  a new one replaces it, and a server restart forgets it. Case, dashes and spaces do not matter, and `I`/`L` read
  as `1`, `O` as `0`; the comparison is constant-time. The right code with a taken name gets 409 and stays valid. The
  phone enters it with a device name on the pairing screen. The server answers with
  `Set-Cookie: pd_device=<32 random bytes, base64url>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`
  (400 days, the most browsers keep) and stores only `{name, hash: sha256 hex, pairedAt, lastSeen?}` in
  `serve/devices.json` (mode 600) as `{"devices": [...]}`; `lastSeen` is written at most every 10 minutes. Device
  names are unique (exact match), 1 to 40 characters after trimming, without control characters.
- **Revocation.** `pi-durable serve devices --revoke NAME` calls `admin.revoke`: the device leaves
  `devices.json`, and its open connections get `bye {code: 4001}`.
- A login removed from `PI_DURABLE_ALLOW_LOGIN` takes effect at the next `serve` start.

## Client messages

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `protocol: number`, `client: string`, `visible: boolean` | First message. `client` is free text for the journal, e.g. `pi-durable-tui 0.1.0`. |
| `req` | `id: number` (integer ≥ 0), `op: Op`, `params: object` | A request; see [Ops](#ops). A missing `params` reads as `{}`. |
| `visible` | `visible: boolean` | The user can or cannot see this client now (a tab in front, a terminal attached). |
| `ping` | `n: number` (integer ≥ 0) | Liveness; answered by `pong` with the same `n`. |
| `machine.result` | `id: string`, `result: MachineToolResult` | Result of a dispatched execution; accepted only from the assigned, registered socket connector. |

## Server messages

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `protocol`, `server` (version), `boot`, `assets`, `peer: 'socket' \| 'web'`, `cwd`, `tools: {remote: 'confirm' \| 'off', idleMinutes?}`, `machines?: true`, `pushKey?`, `device?` | The answer to `hello`. `boot` changes at every server start; `assets` is a hash of the web app's files. `pushKey` is the VAPID public key (base64url), for web peers when push works. `device` is the web device's name. |
| `machine.call` | `id: string`, `target: MachineTarget`, `name: 'read' \| 'write' \| 'edit' \| 'bash'`, `args: JsonObject` | Execute on the exact registered machine/cwd, with a stable execution ID. |
| `machine.cancel` | `id: string` | Explicitly cancel a dispatched call; not rollback of effects. |
| `ready` | — | The initial state is complete. |
| `status` | `status: SessionStatus` | The whole status, each time it changed (compared as JSON). |
| `snapshot` | `feed: string`, `items: ChatItem[]` | A feed's whole item list: replaces the client's mirror. |
| `items` | `feed: string`, `ops: ItemOp[]` | Changes to a feed since its last `snapshot` or `items`; see [Feeds](#feeds-and-item-ops). |
| `feed.end` | `feed: string`, `reason: string` | The feed ended (its agent is gone, or the server is closing it). No more messages for it. |
| `notice` | `text: string`, `level: 'info' \| 'warn' \| 'error'` | A host notice for the client to show; `UiSession.onNotice`. |
| `res` | `id`, `op`, `ok: true`, `result` | A request succeeded; `result` is per op. |
| `res` | `id`, `ok: false`, `error: {code: ErrorCode, message}` | A request failed. `id` is -1 when the request's id was unreadable. |
| `pong` | `n` | The answer to `ping`. |
| `bye` | `code: number`, `reason: string` | The last message before the server ends the connection; see [Close codes](#close-codes). |

`SessionStatus`, `AgentStatus`, `MemoryStats`, `ChatItem`, `ViewLine` and `ModelChoice` are the types of
[src/ui/types.ts](../src/ui/types.ts). `user` and `tool` items may carry `images: {mimeType, data}[]`; an image larger
than `IMAGE_LIMITS.wireBytes` goes with empty `data`, and clients show a placeholder. JSON drops `undefined`: a missing `status.memory` or `memory.lastError`
reads as `undefined`, and `memory` may also be `null`.

## Ops

| Op | Params | Result | Peers | Errors besides `bad_request` |
|---|---|---|---|---|
| `send` | `text`, `requestId?`, `steer?`, `target?: MachineTarget`, `images?: {mimeType, data}[]` | `null` | both | `unavailable`, `failed` |
| `machine.register` | `registration: {target: MachineTarget, enabled: boolean}` | `null` | socket | `forbidden`, `unavailable`, `failed` |
| `machine.set` | `enabled: boolean`, `confirm?: 'enable-tools'` | `null` | socket | `forbidden`, `unavailable`, `failed` |
| `machine.list` | — | `{machines: MachineRegistration[]}` | both | |
| `abort` | — | `null` | both | |
| `stopAgents` | `name?` | `{names}` | both | |
| `feed.open` | `name` | `{feed}` | both | `not_found` |
| `feed.close` | `feed` | `null` | both | `not_found` |
| `feed.resync` | `feed` | `null` | both | `not_found` |
| `memory.view` | — | `{lines: ViewLine[]}` | both | |
| `memory.zoom` | `id`, `n` (≥ 1) | `{text}` | both | `not_found`, `unavailable` |
| `models` | — | `{models: ModelChoice[]}` | both | |
| `model.set` | `provider`, `id` | `null` | both | `failed` |
| `tools.set` | `enabled`, `confirm?: 'enable-tools'` | `null` | both | `forbidden`, `failed` |
| `thinking.levels` | — | `{levels: string[]}` | both | |
| `thinking.set` | `level` | `null` | both | `failed` |
| `push.subscribe` | `subscription: {endpoint, expirationTime?, keys: {p256dh, auth}}` | `null` | web | `forbidden`, `unavailable` |
| `push.unsubscribe` | `endpoint` | `null` | web | `forbidden`, `unavailable` |
| `admin.backup` | `out?` | `{path, bytes}` | socket | `forbidden`, `failed` |
| `admin.pair` | — | `{code, expiresAt}` | socket | `forbidden`, `unavailable` |
| `admin.devices` | — | `{devices: {name, pairedAt, lastSeen?}[]}` | socket | `forbidden`, `unavailable` |
| `admin.revoke` | `name` | `null` | socket | `forbidden`, `not_found`, `unavailable` |

Times are milliseconds since the epoch. Every op answers `bad_request` to malformed params, `unknown_op` when the
server does not know it, and `unavailable` while the server shuts down. Each maps to one `UiSession` method:

- **`send`** is `UiSession.send`: admitted durably, answered when admitted, not when Pi answers (the feed shows
  that). Text that is empty after trimming is `bad_request`, unless `images` are sent. `images` (ADR 0031) are base64
  PNG, JPEG, GIF or WebP, at most 4, each at most `IMAGE_LIMITS.sendBytes` (900 KiB of base64) with magic bytes
  matching its `mimeType` (src/protocol/images.ts); anything else is `bad_request`. When Pi's model takes no images,
  the send is `failed` and nothing is admitted. With `requestId` (1 to 128 characters, unique per
  message: e.g. `<client>-<random>-<counter>`), the server submits with pi-durable's request id, so a repeat is
  admitted once. A client resends a `send` whose `res` a dropped link lost only with its `requestId`. An idle Pi
  starts a run. Protocol 3's machine-routed admission rejects a busy-root user send (including `steer: true`)
  rather than queueing or steering it; rejection is a `failed` response. The optional `steer` field remains
  parseable, but cannot override this policy. The web app may still request steering while Pi works, and receives
  the same rejection. A remote TUI always
  supplies `target`; without it, a routed server uses its own server destination. Routing binds the request ID
  before admission, and a repeat ID cannot change destination, even if its original admission was rejected.
  See [Machine routing and execution](#machine-routing-and-execution).
- **`abort`**, **`stopAgents`**: as the session's `abort` and `stopAgents`; `names` lists the agents stopped,
  sub agents first, and is empty for an unknown name.
- **`feed.open`** opens an agent's conversation by name (case-insensitive) and returns its feed id, an opaque
  string (`ROOT_FEED`, `"root"`, is Pi's). A `snapshot` of it follows the `res`. Opening an open feed again returns
  the same id and sends a fresh snapshot. The server ends the feed with `feed.end` if the agent disappears: once
  the agent has been in `status.agents`, it leaving that list ends its feed.
- **`feed.close`** closes an agent feed this connection opened: no more messages for it. The root feed cannot be
  closed (`bad_request`).
- **`feed.resync`** asks for a fresh `snapshot` of a feed, after `applyOps` returned `'resync'`.
- **`memory.view`** and **`memory.zoom`** are `UiSession.memoryView` and `zoom`. `memory.zoom` answers
  `not_found` for a line that does not exist, with the zoom tool's message (it names the tree's roots).
- **`model.set`** is `UiSession.setModel`; `failed` carries the readable reason (unknown model, no credentials,
  or saved but not written as the default).
- **`thinking.levels`** and **`thinking.set`** are `UiSession.thinkingLevels` and `setThinkingLevel`: the reasoning
  efforts the current model takes, lowest first, and setting one for Pi and its agents, saved as the default.
  `failed` carries the readable reason (a level the model does not take, or saved but not written).
- **`tools.set`** is `UiSession.setTools`, with the remote tools policy:
  - Turning tools on needs `confirm: 'enable-tools'` (the client asked its user first); without it,
    `bad_request`. Turning them off needs nothing.
  - A web peer may turn them on only when `welcome.tools.remote` is `confirm` (`PI_DURABLE_REMOTE_TOOLS`);
    otherwise `forbidden`, checked before the `confirm`. Socket peers always may.
  - Every change is broadcast as a `notice` (`warn` for on, `info` for off) naming who made it (the device, or
    "terminal"), and written to the server's log (the systemd journal).
  - The server starts with tools on unless `--no-tools` (ADR 0025), held to the protected folders. Only with
    `PI_DURABLE_TOOLS_IDLE_MIN` set is `welcome.tools.idleMinutes` sent: after that many minutes with no run (Pi and
    agents idle), the server turns them off and broadcasts a notice. Without it they stay on.
- **`push.subscribe`** stores the browser's push subscription for this device, replacing one with the same
  endpoint; `endpoint` must be an `https:` URL. **`push.unsubscribe`** removes it; an unknown endpoint is not an
  error. The server pushes when Pi finishes a run or an agent reports while no client is visible.
  - The endpoint must be a known push service on port 443: `fcm.googleapis.com`, `*.push.apple.com`,
    `*.notify.windows.com`, `updates.push.services.mozilla.com` or `*.push.services.mozilla.com`. Anything else
    (`http:`, an IP, `localhost`, another host) is `bad_request`, so a forged subscription cannot point the
    server's requests inside the network. `keys.p256dh` must be an uncompressed P-256 point and `keys.auth` 16
    bytes, both unpadded base64url as `PushSubscription.toJSON()` gives them.
  - **The push payload**, what the service worker reads with `event.data.json()`, is `{title, body, tag}`: three
    strings, UTF-8 JSON of at most 3993 bytes (the server cuts `body`, ending it with `…`, to fit). Pass `tag` to
    `showNotification` as its `tag`, so a newer notification replaces an older one with the same tag. The same
    tag is the push's `Topic` (hashed when it is not 1 to 32 base64url characters), so a push service holding
    undelivered pushes keeps only the newest per tag. With `PI_DURABLE_PUSH_PREVIEW=off`, `body` holds no chat
    text. Pushes are aes128gcm-encrypted (RFC 8291) and sent with `TTL: 86400` and `Urgency: normal`.
- **`push.subscribe`** and **`push.unsubscribe`** answer `unavailable` when the server has no push (no web
  listener, or its keys could not be made).
- **`admin.backup`** writes an online backup (`VACUUM INTO`, then a copy of the `.unii` directory and
  `settings.json`) into a new directory under `out` (an absolute path, else `bad_request`; default `backups/`
  beside the database), and returns that directory and its size in bytes. The directory is named for the UTC
  time, `2026-10-19T03-00-00Z` (with `-2`, `-3`, … for another in the same second); afterwards such directories
  in `out` older than 14 days are deleted, and nothing else there.
- **`admin.pair`**, **`admin.devices`**, **`admin.revoke`**: see [Web peers](#web-peers). They answer
  `unavailable` when `serve/devices.json` could not be read at the server's start.

## Machine routing and execution

`welcome.machines: true` advertises immutable run/session routing and execution
connectors. It is optional for protocol compatibility, but the remote CLI
requires it **before sending any user message**; matching protocol 3 alone does
not replace this capability check. The machine messages, ops and optional fields
are additive in shape, but `PROTOCOL` is bumped to 3 because routed admission now
rejects busy-root user sends instead of queueing or steering them. This changes
existing `send` semantics; clients and server must be updated together.

A `MachineTarget` is `{machineId, cwd, label}`. Each field is a nonempty string
without control characters: `machineId` is at most 128 code units, starting with
an ASCII letter/digit and containing only letters, digits, `.`, `_`, `:` or `-`;
`cwd` is an absolute path of at most 4096 code units; `label` is display text of at
most 256. The remote CLI canonicalizes its launch cwd. `machineId: 'server'` is
reserved for the host; connectors cannot register it. The exact machine ID and
cwd select execution; a label is not authorization.

- **`machine.register`** registers one socket connection's target and current
  process grant. It is sent after `ready` and again after reconnect. A connection
  cannot change its machine/cwd, and two active connectors cannot register the
  same machine/cwd. `enabled` reflects this process's explicit local permission,
  not a persisted capability or a server-wide grant.
- **`machine.set`** changes only this connector's grant. Enabling requires
  `confirm: 'enable-tools'`; disabling requires none and may cancel its assigned
  work. A connector must register first. Both the server's coding-tools gate and
  the connector grant must be on to dispatch. Local launches and `serve` default
  to guarded tools on; remote connectors independently default off unless
  `--allow-tools` or confirmed `/tools on` is used.
- **`machine.list`** returns live registrations, not a durable device registry or
  authority to retarget an existing run.
- A submitted message's request ID, root run, and each spawned agent/delegated
  standing-agent session have immutable destinations. Existing sessions never
  move when messaged or reconfigured. New agent delivery request IDs inherit the
  exact source session's route atomically before submission, including report-only
  root runs. Unmapped legacy inputs, conflicting destinations and old unpinned
  sessions fail closed; there is no implicit server fallback.

`machine.call.id` is the persisted chat namespace plus durable tool task ID,
not a connection-local request counter (at most 512 code units, no controls).
`args` is a JSON object; nonfinite numbers and nesting deeper than 64 are refused.
The broker waits for the exact enabled machine/cwd, never dispatches to another
computer, and accepts `machine.result` only from the connector assigned that ID.
A lost link does not cancel local work. Reconnection resends the same execution
ID so the executor can join live work or return its cached result. Explicit
abort, disabling tools or server shutdown may send `machine.cancel`; this cannot
undo effects already made.

`MachineToolResult` accepts optional `output` (text or base64 image blocks),
`structuredOutput`, `details`, `isError`, and diagnostics
`{severity: 'info' | 'warn' | 'error', message, code?}`. Image MIME types are PNG,
JPEG, GIF, WebP or BMP. Other structured values are JSON data. The executor bounds
the encoded result to `LIMITS.clientMessage` in both code units and UTF-8 bytes;
a larger result is discarded and cached as `RESULT_TOO_LARGE`.

Before effects, the workstation fsyncs an intent and payload fingerprint under
its hashed execution-ID ledger. Duplicate payloads join/return cached work;
changed payloads refuse. An unresolved intent after a worker crash returns
`INDETERMINATE`, never reruns automatically. Native tool replay policy stays in
force: a server restart can settle an unsafe tool as interrupted/unknown instead
of dispatching again. This is **not** exactly-once arbitrary bash or transactional
side effects. Retain the ledger and inspect uncertain changes before creating a
new execution. Graceful connector close currently drains admitted calls, so an
unbounded shell command may delay exit.

Workstations support native coding/read tools, including the `autoreview` kit's fixed helper command carried
as a native `bash` call (no additional wire operation). They run through
`GuardedEnv`, including hidden local state/auth, client config and ledger,
read-only system folders and bubblewrap bash. Remote-target `browser_*` and
`web_fetch` calls refuse instead of silently running on the server. Server-target
sessions retain their network kits and egress policy.

## Feeds and item ops

The server keeps, per connection and per open feed, the item list it last sent (`sent`). At each flush it computes
the current items as they go on the wire, `wire = items.map(wireItem)`, then `diffItems(sent, wire)`:

- `'snapshot'`: it sends `snapshot {feed, items: wire}`.
- ops: it sends `items {feed, ops}` when there are any.

Either way `sent = wire`. The client applies each message to its mirror: a snapshot replaces it; ops go through
`applyOps(mirror, ops)`.

### Item ops

| `op` | Fields | Applied to the mirror |
|---|---|---|
| `put` | `item: ChatItem`, `before?: string` | The item with `item.id` is replaced in place. A new id is inserted before the item `before`, or appended when `before` is absent. |
| `append` | `id`, `field: 'text' \| 'output' \| 'args'`, `at: number`, `text` | The item's `field` must be exactly `at` code units long; `text` is appended to it. Nothing else changes. `text` is a field of every kind but `tool`; `output` and `args` are a tool's. |
| `del` | `id` | The item is removed. |

`diffItems` produces, in this order: every `del`; then, in the new list's order, for each item that both lists
hold, nothing if it is unchanged, one `append` per field when only `text`, `output` or `args` grew (the old value
is a prefix of the new), or else one `put`; and for each new item a `put` with `before` set to the next item
both lists hold, or no `before` when none follows.

**The order rule.** Ops never move an item. When the items both lists hold are not in the same relative order,
or an id repeats in either list, `diffItems` returns `'snapshot'`. New items may appear anywhere: `before` places
them.

**Resync.** `applyOps` returns `'resync'` when an op does not fit the mirror: an `append` whose `at` differs or
whose field the item lacks, or an unknown `id` or `before`. The client then keeps its last good mirror, sends
`feed.resync {feed}`, ignores `items` for that feed until the next `snapshot`, and replaces the mirror with it.

**Clipping.** `wireItem` clips a tool item's `output` and `args` to `LIMITS.clip` (64 Ki code units) with
`clip()`: the head and the tail are kept, around `\n… [N characters clipped] …\n`, and a surrogate pair is never
split. Every other field goes whole. A growing output past the limit goes as `put`s, since its clipped form is no
longer a prefix of the next.

## Backpressure

The server syncs state rather than queueing events, so a slow client gets the latest state, not every step:

- Each connection holds `sent` per feed and the last status sent. A change (feed or status) schedules a flush
  at most `LIMITS.flushMs` (50 ms) later; a flush diffs the current state against what was sent.
- A `status` goes at most every 250 ms (4 a second; it changes with every streamed token), carrying the latest.
- A flush is skipped while the connection has more than `LIMITS.highWater` (256 KiB) unsent (WebSocket
  `bufferedAmount`, socket `writableLength`), and retried at the next tick. Skipping loses nothing: the next diff
  covers it.
- `res`, `notice`, `pong`, `feed.end` and `bye` are events: always written, in order, never coalesced.
- When the unsent bytes stay above `LIMITS.slowBytes` (8 MiB) for `LIMITS.slowMs` (60 s), the server sends
  `bye {code: 4008}` and closes. The client reconnects and gets a fresh snapshot.

## Reconnect and resume

There is no session resumption: every connection starts from `hello` and gets the whole state again.

- After a close other than 1000, 4000 and 4001, or a dead link, the client reconnects with backoff: 0.5 s, doubling
  to 10 s, ±20% jitter (the attached TUI, whose server is on the same machine: 0.25 s doubling to 5 s). While it
  does, a client shows its last state and says it is reconnecting (the attached TUI's footer: `reconnecting…`).
- A phone that sleeps freezes the page, and the socket open at the time is usually dead on waking, with no close.
  So a client gives up on an attempt (the web app's `/api/me` gate, or a socket that neither opens nor closes)
  after `LIMITS.connectMs` (10 s). When the app comes back to the front or the browser comes online, the web app
  pings at once and drops the link if nothing answers within `LIMITS.wakeMs` (5 s); if it was already
  reconnecting, it starts a fresh attempt at once, with the backoff reset, abandoning one that hangs. Its banner
  says "Reconnecting…" only after 2 s, so the usual reconnect on waking is not shown.
- The server's work never depends on a client: Pi and agents keep running while every client is away (a turn
  started from a phone that then sleeps finishes, and its answer is there on the next connection).
- Requests pending when the link dropped reject on the client with "connection lost", except a `send` with a
  `requestId`, which a client may keep and resend on the next connection (the attached TUI does). Request ids
  may start over on the new connection.
- After `ready`, the client opens again the agent feeds it had open; their ids may differ.
- `welcome.boot` different from the last one: the server restarted. `welcome.assets` different: the web app
  reloads itself, after a service worker update and once the service worker has revalidated its files
  ([ADR 0032](decisions/0032-web-shell-stale-while-revalidate.md)).

## Errors

| `code` | When |
|---|---|
| `bad_request` | Malformed message or params; `tools.set` enabling without `confirm`; empty `send`. |
| `unknown_op` | The server does not know the op. |
| `not_found` | No such agent, feed, memory line or device. |
| `forbidden` | Not for this peer: `admin.*` from the web, `push.*` from the socket, tools when the remote policy is `off`. |
| `failed` | The op ran and failed; `message` says why, readably. |
| `unavailable` | Not now: the server is shutting down, or the memory is not open. Retrying later may work. |
| `version` | A request before `hello`. |

`message` is always readable by a person; clients show it as is. A client treats an unknown code as `failed`.

## Close codes

| Code | `CloseCode` | Meaning | Client |
|---|---|---|---|
| 1000 | `normal` | Detached, or closed by the server | done |
| 1012 | `restart` | The server is restarting or stopping | reconnect |
| 4000 | `version` | No valid `hello`, or another protocol version | stop; the web app reloads once, the TUI tells the user to update |
| 4001 | `unauthorized` | The device was revoked, or the login is not allowed | stop; the web app shows the pairing screen |
| 4008 | `tooSlow` | The client read too slowly | reconnect |

Any other code, or a close without `bye`: reconnect.

## Versioning

- `PROTOCOL` is 3. `hello` and `welcome` carry it, and the server refuses another (4000).
  Version 3 changes routed `send` admission: a busy root rejects user sends, including steering requests,
  instead of queueing/steering them. This semantic incompatibility requires updating clients and server together.
- Additive changes keep the version: a new message type, op, error code, close code or optional field. Receivers
  therefore ignore what they do not know: a message with an unknown `t` is ignored, unknown fields are dropped by
  the parser, an unknown op gets `unknown_op`, an unknown error code reads as `failed`.
- Anything else bumps it: removing or renaming a message, op or field; a new required field; a new `ChatItem`
  kind or item op (mirrors cannot skip one); a change of meaning.

## Example

```
→ {"t":"hello","protocol":3,"client":"pi-durable-tui 0.1.0","visible":true}
← {"t":"welcome","protocol":3,"server":"0.1.0","boot":"k3j","assets":"9f2","peer":"socket","cwd":"/home/me/projects","tools":{"remote":"confirm"},"machines":true}
← {"t":"status","status":{"model":"claude-cli/sonnet","thinkingLevel":"high","toolsEnabled":false,"busy":false,"queued":0,"memory":{"messages":12,"unsummarized":0,"active":0,"failed":0,"viewBytes":2048,"viewLines":3},"agents":[]}}
← {"t":"snapshot","feed":"root","items":[{"kind":"user","id":"e40","text":"hi"},{"kind":"assistant","id":"e41","text":"Hello!","streaming":false}]}
← {"t":"ready"}
→ {"t":"req","id":1,"op":"send","params":{"text":"count the boats","requestId":"tui-k3j-1"}}
← {"t":"res","id":1,"op":"send","ok":true,"result":null}
← {"t":"items","feed":"root","ops":[{"op":"put","item":{"kind":"user","id":"e42","text":"count the boats"}}]}
← {"t":"items","feed":"root","ops":[{"op":"put","item":{"kind":"assistant","id":"live1.0","text":"There","streaming":true}}]}
← {"t":"items","feed":"root","ops":[{"op":"append","id":"live1.0","field":"text","at":5,"text":" are 3."}]}
→ {"t":"req","id":2,"op":"tools.set","params":{"enabled":true}}
← {"t":"res","id":2,"ok":false,"error":{"code":"bad_request","message":"Turning tools on needs confirm: 'enable-tools'."}}
```
