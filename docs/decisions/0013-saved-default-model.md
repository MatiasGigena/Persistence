# 0013. A model chosen in session is saved as the default, beside the database

## Status

Accepted, 2026-10-19

## Context

The terminal UI's `/model` switches Pi's model without a relaunch. pi-durable already stores the model in Pi's agent
config, but every work launch overwrites that config with the launch's choice, so a switch would be lost at the next
launch unless the launch knows about it. `--model` and `PI_DURABLE_MODEL` are explicit choices that must keep
working, and inspection launches must create nothing.

## Decision

- `/model` checks the model as a launch does (catalog, credentials, no `anthropic` subscription), then applies it to
  Pi with `root.configure({ model })`, re-derives every agent with `syncAgents`, and swaps the memory's summarizer for
  the new provider's compaction model.
- The choice is saved to `settings.json` beside the database, `{"model": "PROVIDER/ID"}`, mode 600, written
  atomically by the host under the database's flock. It is not in SQLite, so it never mixes with the chat's history,
  and it is read before the lock is taken.
- A launch takes `--model`, else `PI_DURABLE_MODEL`, else `settings.json`, else `openai-codex/gpt-6.1-sol`;
  `src/host/config.ts` resolves it and reports the source.
- Coding tools are not saved ([ADR 0009](0009-tools-opt-in.md)); neither is the thinking level.

## Consequences

- The next launch starts on the last model picked, for Pi, its agents and compaction.
- A saved model that can no longer run (signed out) stops the launch with a message naming the file; `--model`
  overrides it.
- `settings.json` is a new persisted file name: renaming it would silently drop users' saved defaults.
- Databases that share a directory share the file.
