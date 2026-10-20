# 0024. Reasoning effort is chosen in session and saved like the model

## Status

Accepted, 2026-10-20. Amends [ADR 0013](0013-saved-default-model.md), which left the thinking level unsaved.

## Context

The reasoning effort (pi-ai's thinking level) could only be set with `--thinking` at launch, and every work launch
overwrote Pi's stored level with that flag's value, `high` by default. Changing it meant a relaunch, and the
choice was lost at the next one. Opus 5.5 is slow at `high` and better at `xhigh` or `max` for hard tasks, so the
effort is something a user adjusts while chatting, as the model is.

## Decision

- The web app has a chip beside the model's chip that opens the level list; the terminal UI has `/effort`. Both pick
  a level from those the current model takes (pi-ai's
  `getSupportedThinkingLevels`); `/effort LEVEL` sets one directly. The `thinking.levels` and `thinking.set` protocol
  ops do the same for attached clients (additive: no `PROTOCOL` bump).
- The level is applied with `root.configure({ thinkingLevel })`, then `syncAgents`, so Pi and every agent use it
  from their next request.
- It is saved to `settings.json` beside the model, `{"model": …, "thinkingLevel": "xhigh"}`. Writing one field keeps
  the other.
- A launch takes `--thinking`, else `settings.json`, else `high`. With `--model`, a broken `settings.json` does not
  stop the launch; only the saved level is lost.
- `claude-cli` models declare `xhigh` and `max`, which the CLI's `--effort` takes, so both can be picked.

## Consequences

- The next launch starts at the last effort picked.
- `thinkingLevel` is a new key in a persisted file: renaming it would silently drop users' saved effort.
