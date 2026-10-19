# Contributing

Persistence is a personal, experimental project. These notes keep changes consistent.

## Setup

You need Linux, Bash, `flock`, and Node.js 22.19 or newer.

```sh
git clone git@github.com:MatiasGigena/Persistence.git ~/pi-durable-instance
cd ~/pi-durable-instance
npm ci --ignore-scripts
```

The dependencies are pinned at 1.3.0. Change a pin only on purpose, and say why in
the commit and in [CHANGELOG.md](CHANGELOG.md).

## Checks

```sh
npm run check    # node --check on every .mjs in src/ and scripts/, bash -n on the launcher
npm test         # every test/**/*.test.mjs
npm audit --omit=dev
```

Run `npm run check` and `npm test` before every commit. The tests are offline: they
use pi-ai's faux provider, a fake `claude` CLI, and temporary data directories, so
they need no credentials and make no network calls. They include real SIGKILL and reopen
recovery, request deduplication, queued-input recovery after a model failure, tool
opt-in and reset, synchronous FULL commits, pagination, the one global chat, lock
exclusion, shutdown with open stdin, and exactly-once agent delivery.
Node 22 may print its expected experimental SQLite warning.

A real Codex login and model smoke test once returned `durable-ready` and exited
successfully. Repeat one by hand after changes to credentials or model handling.
For `src/providers/`, also run `--model claude-cli/haiku -p 'Reply with exactly:
claude-ready'`, and one prompt with `--allow-tools` that makes Pi read a file.

## Test layout

```
test/host/       CLI parsing, paths, global chat, flock, shutdown
test/runtime/    reopen, request IDs, recovery, tool opt-in, synchronous FULL, transcript
test/memory/     log, tree, view, compactor, uniichat extension
test/agents/     roles, messaging, delivery across close and SIGKILL
test/providers/  claude-cli with a fake CLI, stub MCP server, subscription check
test/fixtures/   faux models, the fake claude CLI, child-process instances
```

Put a test next to the area it covers. Use `test/fixtures/faux-model.mjs` for models, and
`test/fixtures/fake-claude.mjs` (through `PI_DURABLE_CLAUDE_BIN`) instead of a real `claude`.
Give each test its own temporary data directory.

## Code style

- Plain ESM in `.mjs` files. No build step, no TypeScript, no bundler.
- Use Node built-ins and the pinned `@earendil-works/*` packages. Add a dependency
  only when there is no small alternative.
- Write terse code: short functions, early returns, no dead code.
- Comment only the non-obvious why: an invariant, an SDK quirk, a recipe section.
  A function's doc comment states its contract.
- 2-space indentation, LF, UTF-8 (see [.editorconfig](.editorconfig)).

## Rules

- Keep persisted identifiers stable. Existing databases and memory directories
  depend on them:
  - extension names `uniichat` and `agents`;
  - entry kinds `agents.report`, `agents.message`, `host.resume-boundary`;
  - task kinds `agents.anchor` and `agents.deliver`, and their versions;
  - the doc kind `agents.registry`;
  - tool names `zoom`, `date`, `spawn_agent`, `list_agents`, `send_message`,
    `last_message`, `stop_agent`;
  - memory kinds `user`, `pi`, `tool`, `echo`, `work`, `note`, and the `src` key formats;
  - the file names `chat.sqlite`, `<database>.lock`, the `.unii` directory, and its
    `main/`, `tree/`, `view.json`.
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
