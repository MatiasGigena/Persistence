# Architecture

Persistence is a terminal host around one pi-durable conversation: Pi, the root.
Pi's context is a UniiChat memory view instead of its raw transcript. Pi can spawn
agents, and each agent is another conversation in the same database.

## Components

```
 terminal
    │  argv, stdin
    ▼
 bin/pi-durable ──► src/cli.ts ───► flock --nonblock <db>.lock ──► src/host/host.ts
                    parse args       one host per database          chat loop, /commands,
                    resolve paths    (exit 75 if busy)              reply watcher
                                                                        │
                                                                        ▼
                                                          src/runtime/runtime.ts
                                                          Harness.open (SQLite, synchronous FULL)
                                                                        │
                    ┌───────────────────────────────────────────────────┼──────────────────────┐
                    ▼                                                   ▼                      ▼
             CodingTools                                  uniichat (src/memory)         agents (src/agents)
             read/write/edit/bash                         beforeRequest builds view     spawn_agent, list_agents,
             (on unless --no-tools)                       logs every message            send_message, last_message,
                                                          zoom, date                    stop_agent; Deliver tasks
                                                                │
                                                                ▼
                                          chat.unii/  log (main/), tree (tree/), view.json
                                                                ▲
                                                 background compactor (cheap model)
```

- **Launcher** (`bin/pi-durable`): finds a Node.js 22.19 or newer and runs `src/cli.ts`.
  Node strips the types at load: there is no build step ([ADR 0011](decisions/0011-typescript-without-build.md)).
- **CLI** (`src/cli.ts`): sets umask 077, parses arguments, resolves paths, and
  starts the host under `flock`. `--help`, `--version`, and inspection of a missing
  database finish here without a lock. An interactive full-screen launch first probes the
  chat's socket and, when a server answers, attaches to it instead (below).
- **Attached client** (`src/client/`, [ADR 0018](decisions/0018-tui-attach.md)): `attach.ts` decides whether a
  launch probes (`--local`, `--plain`, `-p`, a pipe, `--status`, `--history` and `--resume` never do; `--attach`
  must find a server), then runs the terminal UI in the CLI's own process, with no flock, `ModelRuntime` or
  Harness. `remote-session.ts` is a `UiSession` over the protocol: feeds mirrored with `applyOps`, the last
  status, requests with ids and timeouts. `unix-link.ts` is the reconnecting link: NDJSON on `<db>.sock` (its
  owner checked first), hello within 1.5 s, a ping every 20 s, backoff from 0.25 s to 5 s. Exiting detaches;
  the server keeps working.
- **Host** (`src/host/`): creates the model runtime, registers the `claude-cli`
  provider, checks the model and credentials (refusing a subscription token on
  `anthropic`), opens the instance, resumes pending work, then runs the chosen mode:
  `--status`, `--history`, `--resume`, one prompt, piped stdin, or interactive chat.
  Interactive chat in a terminal is the terminal UI; `--plain` (or a stdout that is
  not a terminal) keeps the line-by-line readline chat and its reply watcher.
- **Terminal UI** (`src/ui/tui/`): `app.ts` runs pi-tui in Pi's default full-screen
  (alternate screen) layout: the chat (`chat.ts`) scrolls above a one-line status
  (`footer.ts`) and the editor; `theme.ts` is its palette, and `panels/` holds the
  `/agents`, `/mem`, `/model` and `/effort` overlays (`panels/model.ts` is the model picker, `panels/effort.ts` the
  reasoning effort picker;
`panels/frame.ts` also has the one-key confirmation `/tools on` asks). It knows the
host only through `src/ui/types.ts`.
  Below 60 columns (`NARROW` in `theme.ts`) every part switches to a compact layout
  for phones (ADR 0014).
  On exit it prints the chat to the main screen, so it stays in scrollback. While it
  runs, the host's console warnings go to the session's `notify()`, and every client shows them as chat
  notices (`UiSession.onNotice`).
- **Protocol** (`src/protocol/`): the wire protocol of server mode ([protocol.md](protocol.md)): message
  types, parser, and the item diff and mirror that sync a `UiSession` across a link. Plain TypeScript for Node
  and the browser alike. The server (`src/server/`), the attaching client (`src/client/`) and the web app
  (`src/web/`) are built on it ([plan](plans/server-and-web.md), ADRs 0016 to 0022).
- **Server** (`src/server/`, ADR 0016): `pi-durable serve` runs the host without a terminal, under the same
  flock (`serve.ts`, entered from `host.ts`). It opens the chat with the tools on (ADR 0025), listens on the Unix socket
  (`transport-unix.ts`) and, when configured, the web listener (`transport-ws.ts`), then serves one
  `createUiSession()` through the hub. `hub.ts` fans the session out: one `Connection` per peer
  (`connection.ts`: handshake, ops, per-feed sync by `diffItems`, backpressure, keepalive), agent feeds opened
  once by refcount, the remote tools policy and idle tools-off, and the push triggers. `admin.ts` is the CLI's
  side of `backup`, `serve pair` and `serve devices`; `backup.ts` writes backups as the writer (ADR 0022);
  `store.ts` holds `serve/`'s JSON files.
- **Runtime** (`src/runtime/`): opens SQLite and the pi-durable `Harness`,
  installs the three extensions, and configures Pi for this launch.
- **Memory** (`src/memory/`): the UniiChat log, tree, view, and compactor, plus the
  `uniichat` extension that feeds the view to Pi.
- **Agents** (`src/agents/`): the agent registry, the agent tools, and the
  `agents.deliver` tasks that move messages and reports between conversations.
- **Providers** (`src/providers/`): the `claude-cli` model provider, which runs
  each request through the official `claude` CLI and returns its tool calls to
  the Harness, and the `anthropic` subscription check. See [models.md](models.md).

## How a turn flows

1. You type a line. The host submits it to the root:
   `root.submit({ type: 'input', content })`.
2. The Harness commits the input and runs a generation task for the root conversation.
3. Before each model request, the `uniichat` extension's `beforeRequest` hook:
   - records the current system prompt and tools, so compactions share their prefix;
   - logs what an earlier run left unlogged (a reply cut by `/stop` or a failure,
     with `[cut off: why]`), so it is in the view, then the run's new message (or
     agent report) to `chat.unii/main/`; the view still ends before that message;
   - waits up to 8 s for pending summaries, then uses placeholders;
   - replaces the request with: system prompt, the view in `<chat>` tags, a
     `<turn>` block with the current date and time (and the agents at work, when the
     host passes `atWork`), the previous exchange (at most 16,000 bytes), the run's new
     message after `Turn: the user's new message:` (only its last parts when it is
     over 128,000 bytes, the first ones summarized into the view), and the run's own
     steps.
   A run is everything after the last final answer, or after the last reply of an
   earlier run that failed or was stopped: such a run is never sent again raw. The
   view, turn block, and previous exchange are frozen for the run, so every request
   in one run shares a prefix. Tool results over 30,000 characters are clipped in the
   request.
4. The model answers. `afterResponse` logs Pi's text as `pi`. `afterTool` logs each
   tool call as `tool` right before its result as `echo`; a call left without a result
   is logged alone by the next request. Every log line has a `src` key, so a replay
   never logs it twice.
5. Tool calls run as tool tasks. Coding tools are present unless the launch has `--no-tools` or `/tools off` was used.
   They run in the guarded environment (`src/runtime/guard.ts`, ADR 0025): the chat's state and credentials are
   hidden, system folders read-only, and bash runs in bubblewrap.
6. The final answer is committed as a `pi.assistant` entry. The host's reply watcher
   subscribes to the root's view and prints each new `pi.assistant` and
   `agents.report` entry, including replies to agent reports that no prompt waited for.
7. Each log append wakes the compactor. In the background it summarizes new
   messages into leaves and merges pairs into parents, at most 8 calls at once, with
   the cheap compaction model. Finished nodes are appended to `chat.unii/tree/`, and
   the view is refit and saved to `view.json`.

pi-durable's own compaction is on in the Harness settings, for agents. The extension
declines every compaction of the root ([ADR 0015](decisions/0015-agent-compaction.md)).

## Agents and the root

- Pi is pi-durable's root conversation (`ROOT_CONVERSATION_ID`).
- `spawn_agent` creates a background `agents.anchor` task in the spawner's
  conversation and a new conversation owned by that task. Pi's interrupt and idle
  waits do not reach it.
- An agent copies Pi's stored agent config: model, thinking level, extensions,
  tools, cwd, and instructions. The host then removes the `uniichat` extension, so
  agents have no memory view and their turns are never logged. Sub agents also lose
  `spawn_agent` and `stop_agent`.
- `syncAgents` re-derives every agent's config on each work launch, right after Pi
  is configured, and again after `/model` or `/tools` reconfigures Pi. So
  `--no-tools`, `--model` and those switches apply to agents too.
- A new agent's first message starts with Pi's current memory view, then
  `[from Spawner] task`. The spawn first waits up to 8 s for the view's pending
  summaries, since an agent cannot zoom a placeholder.
- pi-durable compacts an agent's conversation near its model's window; Pi's
  compactions are declined.
- Every input to an agent travels in an `agents.deliver` background task. It submits
  with the request ID `agents:<task id>`, waits for the answer, and in one commit
  marks the answer reported and creates the delivery of `[Name] answer` to the parent.
- A report to Pi lands as an `agents.report` input entry. The memory logs it once,
  as a `work` message.
- `zoom("Name")` reads an agent's transcript from SQLite. The registry of agents is
  the `agents.registry` doc in SQLite.

Details: [agents.md](agents.md), [decisions/](decisions/).

## Persistence boundaries

| Store | Holds | Written by | Durability |
|---|---|---|---|
| `chat.sqlite` (with `-wal`, `-shm`) | every conversation (Pi and agents), entries, tasks, submissions, docs such as the agent registry and each conversation's agent config | the Harness | WAL, `synchronous = FULL` |
| `chat.unii/main/YYYY-MM-DD.jsonl` | the memory log: one record `{ i, kind, text, size, date, src? }` per message | `Memory.append` | appended and fsynced per line |
| `chat.unii/tree/YYYY-MM-DD.jsonl` | tree nodes `{ l, i, text }` | the compactor | appended and fsynced per node |
| `chat.unii/view.json` | the chat view and the compaction view | `Memory.save` | written to a temp file, fsynced, renamed |
| `chat.sqlite.lock` | nothing; the flock target | `flock` | none needed |
| `settings.json` (beside the database) | `{ model }`: the default model chosen with `/model` | `writeSettings` (`src/host/config.ts`), on `/model` | written to a temp file, fsynced, renamed |
| `serve/devices.json`, `push.json`, `vapid.json` | paired devices, push subscriptions, the VAPID keys | the server (`store.ts` `writeJson`) | written to a temp file, fsynced, renamed, directory fsynced |
| `backups/<UTC time>/` | `VACUUM INTO` copy, `.unii` and `settings.json` copies | `backup.ts`, as the writer | every file and directory fsynced |
| `chat.sqlite.sock` | nothing; the server's socket | `serve` | removed at stop; a stale one is replaced under the flock |
| Pi's `auth.json` | credentials | Pi's `ModelRuntime` | outside this project |
| `$TMPDIR/pi-durable-claude-*/` | one `claude-cli` request's system prompt and tool list | the provider | removed after the request |

The two stores are not committed together. The memory follows SQLite:

- Log appends are idempotent by `src` (entry ID, message timestamp and hash, tool
  call ID, or report delivery ID). A run replayed after a crash logs nothing twice.
- A log ahead of `view.json` after a crash gets its missing view lines at open.
- A gap in the log refuses to open. An unreadable `view.json` is rebuilt from the log.
- Inspection launches (`--status`, `--history`) do not open the memory directory.

Memory kinds: `user`, `pi`, `tool`, `echo`, `work`, `note`.

## Process model

- One host process per database. The CLI process waits while `flock --no-fork`
  runs the host, and forwards SIGINT, SIGTERM, and SIGHUP to it.
- The lock file is `<database>.lock`, after symlinks are resolved, so an alias of
  the same database is also refused. A second host exits with status 75.
- The memory directory sits beside the database and is covered by the same lock.
  In one process, a second `openMemory` of the same directory throws.
- Without `serve`: no daemon, boot service, or inbound listener. Agents and the compactor run inside
  the host. They stop when it exits and continue at the next work launch.
- `pi-durable serve` is the same host process without a terminal, normally run by systemd
  (`contrib/systemd/`). It listens on a mode 600 Unix socket and, for the web app, on loopback TCP only.
  SIGTERM, SIGINT and SIGHUP send every client `bye` 1012, then close the session and the Harness as above.
  Clients write nothing: they ask the server, which is the one writer.
- `backup` with a server asks it over the socket, and the server copies in one synchronous step
  (`Instance.exclusive`: one operation of the SQLite adapter's queue). Without one, the CLI takes the flock
  and `host.ts` copies.
- With `claude-cli`, each model request runs a short-lived `claude -p` child (with
  its stub MCP server), killed when the reply's message ends or the request aborts.
  A crash mid-request leaves no CLI session behind; the Harness reissues the request.
- Shutdown closes the Harness without aborting durable work. The memory gives
  compaction calls in flight up to 5 s, then saves; unfinished calls are redone at
  the next open.

## Module map

| File | Purpose |
|---|---|
| `bin/pi-durable` | Bash launcher: picks Node (`PI_DURABLE_NODE`, `node`, or Pi's private Node) and runs `src/cli.ts` |
| `src/cli.ts` | Entry: parses arguments, checks Node, resolves paths, runs the host under `flock` |
| `src/host/config.ts` | `--help` text, argument parsing (subcommands `serve`, `serve pair`, `serve devices`, `backup`), path resolution (data dir, database, auth file) and `statePaths` (lock, `.unii` dir, `settings.json`, socket, `serve/`), the model's precedence, `settings.json`, the server's environment (`serveSettings`) |
| `src/host/host.ts` | Model runtime and credential check, modes, terminal chat, /commands, reply watcher, shutdown |
| `src/runtime/runtime.ts` | `openInstance`: SQLite, Harness, extensions, Pi's agent config (`piTools`, `piInstructions`), in-session `setModel` and `setTools`, `exclusive` (a synchronous step on the database, for backups); `transcript`, `answerText` |
| `src/runtime/models.ts` | Model checks shared by launch and `/model` (catalog, credentials, the `anthropic` refusal) and `modelChooser`, the list `/model` shows |
| `src/runtime/recovery.ts` | `resumeInstance` (pending tasks and queued input), `settleAgents` (wait until agents are idle) |
| `src/memory/index.ts` | Public exports of the memory |
| `src/memory/memory.ts` | `Memory`: log, tree, views, compactor scheduling, zoom, date, status; `openMemory` |
| `src/memory/view.ts` | The view: tree lines tiling the log, sawtooth merging, `cut` |
| `src/memory/prompt.ts` | The recipe's system prompt and the leaf and merge compaction tasks |
| `src/memory/summarizer.ts` | Cheap compaction model choice and the pi-ai summarizer |
| `src/memory/extension.ts` | The `uniichat` extension: `beforeRequest` view, logging hooks, `zoom` and `date` tools |
| `src/memory/util.ts` | Sizes, clipping and splitting, line cutting, dates, fsynced appends, atomic writes |
| `src/providers/claude-cli.ts` | The `claude-cli` pi-ai provider: one `claude -p` per request, stream-json to pi-ai events, history folding, auth check |
| `src/providers/claude-cli-mcp.ts` | Stub stdio MCP server that lists Pi's tools to the CLI and runs none |
| `src/providers/anthropic.ts` | `anthropicSubscriptionSource`: detects a Claude subscription credential on the `anthropic` provider |
| `src/agents/index.ts` | The `agents` extension: registry, roles, tools, anchor and deliver tasks; `syncAgents`, `listAgents`, `agentTranscript` |
| `src/protocol/messages.ts` | Wire protocol v1: every message, the op table (`Ops`), item ops, error and close codes, limits |
| `src/protocol/parse.ts` | `parseClientMessage`, `parseServerMessage`: JSON checked field by field from `unknown` |
| `src/protocol/diff.ts` | `diffItems` (item ops between what a peer has and the current items), `wireItem` and `clip` |
| `src/protocol/mirror.ts` | `applyOps`: a client's copy of a feed, or `'resync'` |
| `src/protocol/version.ts` | `PROTOCOL` |
| `src/client/attach.ts` | `probes`, `connect` (the probe), `attachChat` (the CLI's attach routing), `runAttached` (the TUI on a server, "Detached; the server keeps working."), `serverAnswers` |
| `src/client/remote-session.ts` | `RemoteSession`: a `UiSession` over a `ServerLink`; mirrors, status, notices, requests, `send` resent with its requestId after a reconnect, agent feeds re-opened; `attached` for `TuiInfo` |
| `src/client/unix-link.ts` | `ClientLink` (hello and welcome, ping, `bye`, reconnect with backoff), `unixConnector` (NDJSON over the socket, owner checked), `checkSocket` |
| `src/server/serve.ts` | `serve`: opens the chat with tools on (protected folders), the socket, the web listener and push when configured, the session and the hub; resumes pending work; stops on the signal with `bye` 1012 |
| `src/server/hub.ts` | `Hub` (the `PeerHub`): connections, the op handlers, agent feeds by refcount, notices, the tools policy and idle tools-off, push triggers and their suppression |
| `src/server/connection.ts` | `Connection`: one peer's handshake, requests (peer checks, in-flight limit), feed and status sync (`diffItems`, ≤50 ms, gated on `buffered()`, status ≤4/s), slow-peer and silence closes, visibility |
| `src/server/transport-unix.ts` | `listenUnix`: the mode 600 NDJSON socket, stale socket replaced, `bye` before closing; `lineSplitter` |
| `src/server/admin.ts` | The CLI's admin client: `adminRequest` over the socket (owner checked), `backupOverSocket`, `pairCommand`, `devicesCommand` |
| `src/server/backup.ts` | `backup` (`VACUUM INTO` and the `.unii` and settings copies in one step, then `prune`), `backupOffline`, `stamp` |
| `src/server/store.ts` | `writeJson`, `readJson`, `jsonFile`, and narrowing helpers for `serve/`'s JSON files (mode 600, atomic) |
| `src/server/link.ts` | The seams: `PeerLink`, `PeerHub`, `DeviceRegistry`, `PushNotifier` |
| `contrib/systemd/` | `pi-durable.service` (`serve --cwd %h/projects`), `pi-durable-backup.service` and its daily `.timer` |
| `src/server/auth.ts` | `Devices` (the `DeviceRegistry`: pairing codes, `pd_device` cookies by sha256 in `serve/devices.json`), `gate` and `authenticate` (login allow-list, Origin, device) |
| `src/server/static.ts` | The web app's files: `src/web/` at `/`, `src/protocol/`, `marked`; type stripping, ETags, the CSP; `assetsHash` for `welcome.assets` |
| `src/web/index.html`, `manifest.webmanifest`, `offline.html`, `styles.css`, icons | The installable app shell; the only inline script is the `marked` import map, allowed by its CSP hash |
| `src/web/main.ts` | Boots the app: pairing screen, connection banner, header, composer, menus |
| `src/web/link.ts` | WebSocket client: `/api/me` check, hello/welcome, ping, reconnect with backoff, close codes |
| `src/web/store.ts` | Mirrors feeds with `applyOps`, status, notices, pending sends (resent with their requestId) |
| `src/web/chat-view.ts`, `markdown.ts`, `format.ts` | Keyed DOM chat, sanitized Markdown, TUI-parity text helpers |
| `src/web/panels/*` | Sheets: agents, memory zoom, model picker, reasoning effort picker, tools (confirm dialog), settings |
| `src/web/push.ts`, `sw.ts` | Push subscribe on a tap; service worker: network-first shell, offline page, push and click handlers |
| `src/server/transport-ws.ts` | `startWebListener`: HTTP on 127.0.0.1, `/api/me`, `/api/pair`, the app, and `/ws` WebSockets handed to the hub as `PeerLink`s |
| `src/server/push.ts` | `createPush`: Web Push on `node:crypto` (VAPID, aes128gcm), the key pair in `serve/vapid.json` and the subscriptions in `serve/push.json`; the `PushNotifier` the hub calls |
| `tsconfig.json` | Strict TypeScript for `tsc` (no emit): erasable syntax only, `.ts` import specifiers |
| `eslint.config.ts` | typescript-eslint rules: no `any`, written or inferred, and no suppression comments |
| `test/host/` | CLI parsing, paths, global chat, flock, shutdown |
| `test/runtime/` | Reopen, request IDs, recovery, tool opt-in, synchronous FULL, transcript |
| `test/memory/` | Log, tree, view, compactor, extension |
| `test/agents/` | Roles, messaging, stops, reports, `zoom("Name")` pages, exactly-once delivery across close and SIGKILL; an agent's view and compaction through the host wiring |
| `test/client/` | `RemoteSession` against the fake server (snapshot and ops, resync, status and notices, request errors, reconnects, resent sends), the link over real sockets (framing, probe failures, pings, `bye`, backoff), attach routing and the launcher's exit 75 hint, and an end-to-end attach to `serve` with a restart |
| `test/protocol/` | Random feed sequences through `diffItems` and `applyOps`, clipping, every message through JSON and the parsers, malformed input |
| `test/server/` | The hub with a fake session and in-memory links (handshake, version, ops, peer checks, feed refcounts, slow peers, status coalescing, keepalive, tools policy and idle off, push triggers); the Unix socket; `serve` end to end in a child process with a faux model and through the launcher; backups that open, and pruning. Auth: allow-list, Origin, pairing codes, cookies, revoke; static files: stripping, CSP, traversal; the web listener: refused upgrades, links, close codes, frame limits, pairing over HTTP. Push: RFC 8291's vector, the VAPID JWT, endpoint checks, sends to a local server (201, 410, 429, 5xx) |
| `test/providers/` | `claude-cli` against a fake CLI, through the Harness; the stub MCP server; the subscription check |
| `test/fixtures/` | Faux models, the fake `claude` CLI, child-process instances (`serve-faux.ts`: the server on a faux model), `server-fakes.ts` (a fake `UiSession`, `PeerLink` and push for hub tests), and `fake-server.ts` (an in-memory, transport-agnostic server written from protocol.md, for client tests) |
