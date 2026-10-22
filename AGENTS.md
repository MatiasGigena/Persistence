# AGENTS.md

Persistence is a terminal host for one never-ending Pi chat on
`@earendil-works/pi-durable` 1.3.0. Pi's context is a UniiChat memory view, and Pi
can spawn background agents. The launcher is `bin/pi-durable`. The code is strict
TypeScript that Node runs by type stripping: there is no build step.

## Map

- `src/cli.ts`: entry. Parses arguments, takes the flock, spawns the host.
- `src/host/`: `host.ts` (terminal chat, /commands, reply watcher), `config.ts` (CLI options, paths).
- `src/runtime/`: `runtime.ts` (Harness, extensions, Pi's agent config), `recovery.ts` (resume, `settleAgents`), `models.ts` (pickable models and credential checks for `/model`), `guard.ts` (protected folders: the tools' guarded environment and bubblewrap).
- `src/memory/`: UniiChat memory: log, tree, view, compactor, and the `uniichat` extension.
- `src/agents/index.ts`: agent hierarchy, tools, and delivery tasks; `roster.ts`: the standing agents and kit names.
- `src/tools/`: the standing agents' network kits: `browser.ts` (headless Chromium, `browser_*` tools) and
  `web-fetch.ts` (`web_fetch`).
- `src/providers/`: the `claude-cli` provider (official `claude` CLI, stub MCP server) and the `anthropic` subscription check.
- `src/ui/`: the terminal UI. `types.ts` is the contract (it imports nothing); `session.ts` turns pi-durable events, memory and agents into chat items; `tui/` renders them with pi-tui (`tui/panels/` holds /agents, /mem, /model and /effort). The TUI never imports pi-durable.
- `src/protocol/`: the wire protocol ([docs/protocol.md](docs/protocol.md)), shared by Node and the browser, so no `node:` or DOM imports: `messages.ts` (types, ops, codes, limits), `parse.ts`, `diff.ts` (server side), `mirror.ts` (client side), `version.ts`.
- `src/server/`: `pi-durable serve`: hub, connections, Unix socket and WebSocket transports, auth, push, backup.
- `src/client/`: attached TUI and SSH connector: `attach.ts`, `remote-session.ts`, `unix-link.ts`; `config.ts` and `remote.ts` select the central server before local chat resolution, `ssh-link.ts` and `bridge.ts` carry the socket over SSH, `machine-executor.ts` runs guarded tools with a durable local ledger.
- `src/machines/routing.ts`: persisted per-request, run and agent-session execution targets; `src/server/machines.ts`: authenticated connector dispatch, never host fallback.
- `src/web/`: the phone web app, vanilla DOM TypeScript served type-stripped (own `tsconfig.json`; `sw.ts` has `sw/tsconfig.json`). `format.ts`, `store.ts`, `link.ts` and `markdown.ts` stay DOM-free so `test/web/` runs them in Node.
- `test/<area>/*.test.ts`: offline tests per area; `test/fixtures/` holds faux models.
- `tsconfig.json`, `eslint.config.ts`: the type and lint rules `npm run check` enforces.

## Verify

Run `npm run check && npm test` after every change. `check` is tsc, eslint, and
`bash -n` on the launcher; both are offline and take seconds.
A change is done when both pass and the docs below still match the code.

## Invariants

- **Persisted names are frozen.** Extension names, entry, task, and doc kinds, tool
  names, memory kinds and `src` keys, and the `chat.sqlite` / `.unii` file layout
  stay as they are; the full list is in [CONTRIBUTING.md](CONTRIBUTING.md#rules).
  Renaming one breaks existing chats.
- **One writer.** Every write to the database and its `.unii` directory happens in
  the one host process under the CLI's flock. Launch through `bin/pi-durable`.
- **Memory is Pi's alone.** The `uniichat` extension acts only on the root
  conversation; spawned agents get it removed.
- **Exactly-once delivery.** Agent messages and reports travel in `agents.deliver`
  tasks keyed by task ID, and memory appends are keyed by `src`. Keep every replay
  path idempotent.
- **Tools on, held to protected folders.** A local launch and `serve` start with coding tools on unless
  `--no-tools` is passed (ADR 0025). Every tool runs through `GuardedEnv` (`src/runtime/guard.ts`): the chat's
  state and credentials hidden, system folders read-only, bash in bubblewrap; never hand the tools a bare
  `NodeExecutionEnv` outside tests. `/tools on|off`
  switches them for the current launch only; never persist that choice. Launch config and the toggle share
  one tool list (`piTools`), and both reconfigure Pi and its agents. Remote SSH connectors have an additional
  local grant: their tools start **off** unless `--allow-tools` is explicit or `/tools on` confirms them. Neither
  reconnects nor another device's grant can authorize a connector. Never bypass `GuardedEnv` on a connector.
- **Network tools stay in their lanes.** The kits' network tools differ. Every `browser` request goes through
  its own loopback egress proxy, which checks each connection (redirect hops and WebSockets included) and connects
  only to the address it checked: loopback and private addresses are allowed (it debugs the user's apps),
  link-local (cloud metadata) and Tailscale/CGNAT never, and public ones only when the agent has no `read` or
  `coding` kit (`localOnly`: the Reviewer's browser is local only, so it cannot carry files out). Profiles live in
  `chat.unii/browser/`, hidden from the coding tools and left out of backups. `web_fetch` refuses loopback,
  private, link-local, CGNAT and unique-local addresses, on every redirect too. Agents without the `coding` kit
  may message only Pi and their own sub agents, so untrusted web content cannot steer one that has bash. The host
  closes the browsers when the instance closes (`Instance.close`).
- **No unauthenticated listener.** The server listens on loopback TCP (behind `tailscale serve`, with login,
  device and origin checks) or a 0600 Unix socket only; never on a public address. See
  [docs/protocol.md](docs/protocol.md#authentication).
- **No `any`.** tsc strict and eslint `no-unsafe-*` must stay at zero; never add
  suppression comments. Parse external data as `unknown` and narrow it.
- **State stays local.** Commit only source, tests, and docs: never `*.sqlite*`,
  `*.lock`, `*.unii/`, `auth.json`, or `.env`.

## Docs

- Changing the turn flow, persistence, or a file's place: [docs/architecture.md](docs/architecture.md).
- Changing install, paths, recovery, or backups: [docs/operations.md](docs/operations.md).
- Changing `src/memory/`: [docs/memory.md](docs/memory.md); keep its recipe deviations list current.
- Changing `src/agents/`: [docs/agents.md](docs/agents.md).
- Changing `src/providers/` or model routes: [docs/models.md](docs/models.md).
- Changing `src/protocol/`, or what the server or a client sends: [docs/protocol.md](docs/protocol.md); bump
  `PROTOCOL` for anything not additive.
- Making a design decision: add an ADR in [docs/decisions/](docs/decisions/).
- Code style and commit messages: [CONTRIBUTING.md](CONTRIBUTING.md).
