# 0005. Background agents, no waiting or polling

## Status

Accepted, 2026-10-19

## Context

A tool that waits for another agent blocks the caller's run, holds its context open, and makes Pi unresponsive to
the user. Polling with `sleep` or repeated `last_message` calls wastes calls and fills the memory with noise. The
recipe says the master "never waits or polls" for a subagent.

## Decision

- `spawn_agent` and `send_message` return at once.
- Agents run in background tasks owned by `agents.anchor` tasks, so the root's idle waits and aborts do not reach them.
- An agent's final reply at the end of each run is delivered automatically to its parent as `[Name] reply`: a
  follow-up for a busy parent, a new run for an idle one. A report to Pi starts an ordinary Pi run.
- Every role's system section, and Pi's memory prompt, say: never wait for an agent (no sleep, no polling); go on, or
  end the turn.

## Consequences

- Pi can answer the user while agents work; reports print as they land.
- No host submission waits for a report-triggered Pi run, so the chat host watches the root to print them.
- Agents progress only while a host is open. `--resume` waits until only anchor tasks remain; `-p` does not wait.
