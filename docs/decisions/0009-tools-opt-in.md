# 0009. Coding tools are opt-in per launch

## Status

Accepted, 2026-10-19. Amended by [0019](0019-private-access.md); superseded by [0025](0025-protected-folders.md): coding tools are on by default, held to
protected folders.

## Context

`read`, `write`, `edit` and `bash` act on the machine with the user's permissions, with no sandbox and no approval
prompts. pi-durable persists a conversation's tool choices, so a tool enabled once would stay enabled at every later
launch, for Pi and for every agent. Memory and agent tools touch only the chat.

## Decision

- Coding tools are on only when the launch passes `--allow-tools`.
- Every work launch calls `root.configure(agent)` with this launch's tool list, overwriting the stored one, then
  `syncAgents` re-derives every agent from Pi.
- `zoom`, `date` and the five agent tools are always on. The `CodingTools`, `uniichat` and `agents` extensions are
  always installed, so pending tasks remain recognizable.
- Pi's instructions say which case applies, and that older messages cannot enable the tools.

## Consequences

- Tools enabled yesterday are off today unless the flag is given again, for Pi and all agents.
- The flag is the only switch: there is no chat command for it.
- Agents spawned in a launch with tools lose them in the next launch without the flag.

## Amended 2026-10-19

- The terminal UI's `/tools on` and `/tools off` switch the coding tools in session, for Pi and every agent, through
  the same path as a launch: `root.configure` with the tool list of `piTools()` (`src/runtime/runtime.ts`), then
  `syncAgents`. So "the flag is the only switch" no longer holds within a launch.
- The decision stands: the choice is never saved, and every launch still starts with the tools off unless it passes
  `--allow-tools`. Pi's instructions are reconfigured with the tools, and name `/tools` and `--allow-tools` as the only
  ways to turn them on.

## Amended 2026-10-20

- Local launches now start with the coding tools **on**; `--no-tools` turns them off for that launch, and
  `--allow-tools` is kept as a no-op for scripts (giving both is an error). The choice is still never saved.
- `serve` and the admin commands are unchanged: the server starts with the tools off and refuses `--allow-tools`
  (ADR 0019); remote confirmation and the idle switch-off still apply. (Amended by [0025](0025-protected-folders.md):
  the server starts with them on too, and protected folders apply to every launch.)
