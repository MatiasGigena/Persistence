# Contributing

Persistence is an experimental project under active development. These notes keep changes consistent.

## Setup

You need Linux, Bash, `flock`, and Node.js 22.19 or newer.

```sh
git clone https://github.com/MatiasGigena/Persistence.git ~/pi-durable-instance
cd ~/pi-durable-instance
npm ci --ignore-scripts
```

The Pi packages are pinned at 1.5.2. Change a pin only on purpose, and say why in
the commit and in [CHANGELOG.md](CHANGELOG.md); move `SDK` in `src/runtime/sdk.ts` with them (a test holds
the two together).

## Checks

```sh
npm run check      # tsc, eslint --max-warnings 0, and bash -n on the launcher
npm run typecheck  # tsc alone (strict, no emit)
npm run lint       # eslint alone
npm test           # every test/**/*.test.ts
npm audit --omit=dev
```

Run `npm run check` and `npm test` before every commit. The tests are offline: they
use pi-ai's faux provider, a fake `claude` CLI, and temporary data directories, so
they need no credentials and make no network calls. They include real SIGKILL and reopen
recovery, request deduplication, queued-input recovery after a model failure, tool
opt-in and reset, synchronous FULL commits, pagination, the one global chat, lock
exclusion, shutdown with open stdin, and exactly-once agent delivery.
The suite runs at most four test files at once: process-heavy recovery and sandbox
fixtures otherwise compete with the launcher's short readiness deadlines. Launcher
fixtures isolate client preferences, so a saved remote default never reaches a real
server during tests. Node 22 may print its expected experimental SQLite warning.

The tests never reach a real model. After changes to credentials or model handling, run a
smoke test by hand with a real login, such as `pi-durable -p 'Reply with exactly: durable-ready'`.
For `src/providers/`, also run `--model claude-cli/haiku -p 'Reply with exactly:
claude-ready'`, and one prompt that makes Pi read a file.

## Test layout

```
test/host/       CLI parsing, paths, global chat, flock, shutdown, the UiSession
test/runtime/    reopen, request IDs, recovery, tool opt-in, synchronous FULL, transcript
test/memory/     log, tree, view, compactor, uniichat extension
test/agents/     roles, messaging, delivery across close and SIGKILL
test/schedule/   cron expressions, schedules firing once, late and repeating, cancelling, routing
test/providers/  claude-cli with a fake CLI, stub MCP server, subscription check
test/protocol/   wire messages and parsers, item diff and mirror (randomized, seeded)
test/tools/      browser and its egress proxy, web_fetch, autoreview, show_image, code mode
test/ui/         the shared wording, the TUI and its panels
test/server/     hub, auth, Unix socket and WebSocket transports, push, backups, static files
test/client/     attach, remote session, SSH link and bridge, client config
test/machines/   routing, the execution broker and the local executor
test/web/        the web app's DOM-free modules: format, store, link, markdown, cache
test/usage/      the usage report: daily buckets, sampling, compaction spend
test/fixtures/   faux models, the fake claude CLI, child-process instances
```

Put a test next to the area it covers, as `<area>/<name>.test.ts`; tests are typed and
linted like the sources. Use `test/fixtures/faux-model.ts` for models, and
`test/fixtures/fake-claude.ts` (through `PI_DURABLE_CLAUDE_BIN`) instead of a real `claude`.
Give each test its own temporary data directory.

## Code style

- Strict TypeScript in `.ts` files, run by Node's type stripping (Node 22.18 or newer;
  `engines` asks for 22.19). No build step, no bundler; `tsc` only checks.
- Erasable syntax only: no `enum`, `namespace`, or parameter properties. Import with
  `.ts` specifiers, and types with `import type`.
- No `any`, written or inferred, and no `@ts-ignore`, `@ts-expect-error`, or
  `@ts-nocheck`. tsc (strict) and typescript-eslint (`no-unsafe-*`) enforce both;
  tsc also refuses unused locals and imports (`noUnusedLocals`).
- Parse external data (JSON, IPC, process arguments) as `unknown` and narrow it.
  Cast only what is genuinely known, and say why.
- Object shapes are `interface`s; `type` is for unions, intersections, mapped types, and the state of a pi-durable doc
  or task (`defineDoc`, `defineTask`), which must stay a type alias: an interface has no implicit index signature, so
  it is not assignable to the JSON types those take.
- Use Node built-ins and the pinned `@earendil-works/*` packages. Add a dependency
  only when there is no small alternative.
- Write terse code: short functions, early returns, no dead code.
- Comment only the non-obvious why: an invariant, an SDK quirk, a recipe section.
  A function's doc comment states its contract.
- 2-space indentation, LF, UTF-8 (see [.editorconfig](.editorconfig)).

## Rules

- Keep persisted identifiers stable. Existing databases and memory directories
  depend on them:
  - extension names `uniichat`, `agents`, `schedule`, `browser`, `web-fetch`, `autoreview`, `show-image` and `codemode`;
  - entry kinds `agents.report`, `agents.message`, `schedule.fire`, `host.resume-boundary`;
  - task kinds `agents.anchor`, `agents.deliver` and `schedule.wake`, and their versions;
  - the doc kind `schedule.registry`, its schedules' fields, and the request ID form `schedule:<task id>:<occurrence>` (ADR 0038);
  - the doc kind `agents.registry`, and its agents' fields, `standing`, `past`, `session` and `archivedAt` among them;
  - the `agents.deliver` task memo field `session` (the conversation a message delivery chose);
  - the optional `session` number (from 1) in `agents.report` entry data;
  - the protocol ops `agents.archive` and `agents.restore` (ADR 0034), `schedule.cancel` (ADR 0038) and `memory.search` (ADR 0040);
  - the doc kind `host.usage`, its fields `since`, `last`, `days` and `extra`, and the protocol op `usage` (ADR 0039);
  - tool names `zoom`, `date`, `spawn_agent`, `list_agents`, `send_message`,
    `last_message`, `stop_agent`, `delegate`, `schedule`, `list_schedules`, `cancel_schedule`, `web_fetch`, `autoreview`, and the browser's `browser_goto`,
    `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`,
    `browser_screenshot`, `browser_close`, `show_image`, and `codemode` (with pi-durable's `pi.codemode.*` docs);
  - memory kinds `user`, `pi`, `tool`, `echo`, `work`, `note`, and the `src` key formats;
  - the file names `chat.sqlite`, `<database>.lock`, `settings.json` and its `model`,
    `thinkingLevel` and `agents` keys (each agent's `model`, `thinkingLevel`, `tools`,
    `instructions`, `subModel`, `subThinkingLevel`, and the kit names `coding`, `read`,
    `browser`, `web_fetch`, `autoreview`), the `.unii` directory, and its `main/`, `tree/`, `view.json`,
    `browser/<agent name, or conversation id for unnamed callers>/`.
  A change to any of these needs a migration and an ADR.
- One writer per database. Keep every write under the CLI's flock.
- Record each new design decision as an ADR in [docs/decisions/](docs/decisions/).
- Keep the list of deviations from the UniiChat recipe in
  [docs/memory.md](docs/memory.md) current when you change `src/memory/`.
- Update [docs/architecture.md](docs/architecture.md) when you add, move, or remove a file.
- Commit no state: no `*.sqlite`, WAL or SHM files, `.lock` files, `.unii`
  directories, `auth.json`, or `.env`.

## Commits

- Subject: imperative, at most 72 characters, optionally prefixed by the area
  (`memory:`, `agents:`, `host:`, `runtime:`, `docs:`).
  Example: `memory: retry failed leaves on the next append`.
- Body: what changed and why, wrapped at 72 columns. Mention breaking changes.
- One logical change per commit, with its tests and docs.
- Add user-visible changes to `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
