# AGENTS.md

Persistence is a terminal host for one never-ending Pi chat on
`@earendil-works/pi-durable` 1.3.0. Pi's context is a UniiChat memory view, and Pi
can spawn background agents. The launcher is `bin/pi-durable`. The code is strict
TypeScript that Node runs by type stripping: there is no build step.

## Map

- `src/cli.ts`: entry. Parses arguments, takes the flock, spawns the host.
- `src/host/`: `host.ts` (terminal chat, /commands, reply watcher), `config.ts` (CLI options, paths).
- `src/runtime/`: `runtime.ts` (Harness, extensions, Pi's agent config), `recovery.ts` (resume, `settleAgents`), `models.ts` (pickable models and credential checks for `/model`).
- `src/memory/`: UniiChat memory: log, tree, view, compactor, and the `uniichat` extension.
- `src/agents/index.ts`: agent hierarchy, tools, and delivery tasks.
- `src/providers/`: the `claude-cli` provider (official `claude` CLI, stub MCP server) and the `anthropic` subscription check.
- `src/ui/`: the terminal UI. `types.ts` is the contract (it imports nothing); `session.ts` turns pi-durable events, memory and agents into chat items; `tui/` renders them with pi-tui (`tui/panels/` holds /agents and /mem). The TUI never imports pi-durable.
- `src/protocol/`: the wire protocol ([docs/protocol.md](docs/protocol.md)), shared by Node and the browser, so no `node:` or DOM imports: `messages.ts` (types, ops, codes, limits), `parse.ts`, `diff.ts` (server side), `mirror.ts` (client side), `version.ts`.
- `src/server/`: `pi-durable serve`: hub, connections, Unix socket and WebSocket transports, auth, push, backup.
- `src/client/`: the attached TUI: `attach.ts` (probe and routing), `remote-session.ts` (a `UiSession` over the protocol), `unix-link.ts` (the reconnecting socket link).
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
- **Tools off by default.** Every launch starts with coding tools off unless
  `--allow-tools` is passed. `/tools on` enables them for the current launch only,
  after a confirmation; never persist that choice. Launch config and the toggle share
  one tool list (`piTools`), and both reconfigure Pi and its agents.
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
