# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Terminal UI for interactive chat (pi-tui 1.3.0, full screen like Pi's): the chat
  with streaming Markdown, collapsed thinking and tool output (ctrl+t, ctrl+o),
  agent reports, a status line (model, thinking, tools, work, memory, agents), and
  an editor with history and `/help`, `/agents`, `/mem`, `/status`, `/exit`.
  Esc interrupts Pi; Ctrl+D or Ctrl+C twice exits. `--plain` keeps the line chat.
- `/model` in the terminal UI: a picker (also Ctrl+L, as in Pi) listing every model,
  the current one marked; typing filters, and models without credentials are dim
  and show what they need. `/model provider/id` switches directly, with completion.
  The new model applies from the next message and is saved as the default.
- `/tools on` and `/tools off` in the terminal UI switch coding tools for this
  launch; turning them on asks for a one-key `y` confirmation. The footer shows
  `tools on` in yellow.
- `claude-cli` provider: `--model claude-cli/opus`, `sonnet`, `haiku` or `fable`
  runs each request through the official `claude` CLI (`claude -p`, stream-json)
  signed in with your own Claude plan. Claude only proposes tool calls, through a
  stub MCP server that runs nothing; the Pi Harness executes them. Each request is
  isolated from your Claude Code settings, hooks, memory and `CLAUDE.md` files.
  `PI_DURABLE_CLAUDE_BIN` selects the binary. See `docs/models.md` and ADR 0010.
- Compaction with `claude-cli` uses `claude-cli/haiku`, at most 2 calls at once;
  with `anthropic`, `anthropic/claude-haiku-5-5`.
- A model switch applies to Pi, every agent and the compaction model from their
  next request, after the same checks as a launch (catalog, credentials, no
  `anthropic` subscription). The model picker lists `claude-cli`, the current
  provider, `openai-codex`, `openai` (with credentials) and `anthropic`, each
  marked available or not with a short note.
- `settings.json` beside the database (mode 600) keeps the model chosen with
  `/model`. A launch takes `--model`, else `PI_DURABLE_MODEL`, else
  `settings.json`, else `openai-codex/gpt-6.1-sol`; `--status` and the `--plain`
  banner show where it came from. See ADR 0013.

### Changed

- Pi's instructions about the coding tools follow `/tools` and name it, with
  `--allow-tools`, as the only ways to turn them on. ADR 0009 is amended: tools
  can be switched in session but still start off on every launch.
- The `anthropic` provider is refused when its credential is a Claude
  subscription token (a Pi "Claude Pro/Max" login, `ANTHROPIC_OAUTH_TOKEN`, or an
  `sk-ant-oat…` key); it works with an Anthropic Console API key.
- Sources and tests migrated to strict TypeScript (no `any`), checked by tsc and
  eslint; run by Node type stripping with no build step. `npm run check` runs
  tsc, eslint and `bash -n`; `npm run typecheck` and `npm run lint` run each alone.
  See ADR 0011.

## [0.1.0] - 2026-10-19

### Added

- Terminal host for `@earendil-works/pi-durable` 1.3.0, started by the
  `pi-durable` launcher: interactive chat, `--print`, piped stdin, `--history`,
  `--status`, `--resume`, `--request-id`, `--model`, `--thinking`, `--cwd`,
  `--auth-file`, `--database`, `--data-dir`.
- Pi's `ModelRuntime` with the existing Pi credentials; default model
  `openai-codex/gpt-6.1-sol`, thinking `high`; `PI_DURABLE_MODEL`.
- Coding tools (read, write, edit, bash) only with `--allow-tools`, reset on every launch.
- SQLite storage with `synchronous = FULL`, recovery of pending work on reopen,
  and one process per database through `flock` (exit status 75 when busy).
- Private state: umask 077, directories 700, files 600.
- UniiChat memory: a word-for-word log, a background compactor that builds a
  binary tree of lines of at most 512 bytes with a cheap model, a 64–128 KB view
  per turn, and the `zoom` and `date` tools. pi-durable's own compaction is off.
- Agent hierarchy: Pi spawns main agents, main agents spawn sub agents. Tools
  `spawn_agent`, `list_agents`, `send_message`, `last_message`, `stop_agent`.
  Reports reach the parent as `[Name] …`, exactly once across crashes.
- `/help`, `/history`, `/agents`, `/status`, `/exit` chat commands.

### Changed

- **Breaking:** one global chat. Every launch, from any directory, opens
  `chat.sqlite` in the data dir. `--session` is removed. Older per-project
  databases are left untouched and are not imported.
- Source reorganized into `src/host/`, `src/runtime/`, `src/memory/` (was
  `src/unii/`), and `src/agents/` (was `src/agents.mjs`); tests grouped by area
  under `test/`; syntax check moved to `scripts/check.mjs`.

[Unreleased]: https://github.com/MatiasGigena/Persistence/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MatiasGigena/Persistence/releases/tag/v0.1.0
