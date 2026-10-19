# 0004. Agent hierarchy and permissions

## Status

Accepted, 2026-10-19

## Context

Unrestricted spawning lets agents multiply without bound, and agents that all write to Pi flood the one chat whose
memory must stay useful. Agents still need to cooperate across branches.

## Decision

- Three roles: Pi (the root) spawns **main** agents; main agents spawn **sub** agents; sub agents cannot spawn.
- Everyone can `list_agents`, `send_message` and `last_message` any other agent.
- Only Pi and main agents address `Pi`. A sub agent talks to its main agent, whose report reaches Pi.
- `stop_agent`: Pi may stop any agent; a main agent only its own subs; a sub agent none.
- The sub limits are enforced by the tool offer (`spawn_agent` and `stop_agent` hidden), by a `beforeTool` guard,
  and inside each tool.
- Names are 1–32 of `[A-Za-z0-9_-]`, not `Pi`, unique ignoring case.

## Consequences

- The tree is at most three levels deep, and Pi's chat receives only main agents' messages and reports.
- A sub's result reaches Pi only if its main agent relays it.
- Agents are never deleted; the registry grows with every name ever spawned.

See [agents.md](../agents.md#permissions) for the full table.
