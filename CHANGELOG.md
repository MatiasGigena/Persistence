# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
