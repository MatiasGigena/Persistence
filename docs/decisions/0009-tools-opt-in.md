# 0009. Coding tools are opt-in per launch

## Status

Accepted, 2026-10-19

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
