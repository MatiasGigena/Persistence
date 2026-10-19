# 0001. One global chat

## Status

Accepted, 2026-10-19

## Context

UniiChat's premise is one chat that never ends: the chat is the memory. Earlier versions of this host kept one
database per project directory. That splits the memory: what Pi learned in one directory is gone in another, and
the user has to pick a session.

## Decision

- Every launch, from any directory, opens the same database: `<data dir>/chat.sqlite`, where the data dir is
  `--data-dir`, else `PI_DURABLE_DATA_DIR`, else `$XDG_STATE_HOME/pi-durable` (default `~/.local/state/pi-durable`).
- There is no `--session` option and no per-project database. The launch directory only sets the tools' working
  directory (`--cwd`).
- `--database PATH` remains for an explicit file (tests, a separate experiment). Its memory directory sits beside it.
- Older per-project databases are not imported. The memory's `note` kind is reserved for imports, but none exists.

## Consequences

- One memory covers all work, and Pi is told the working directory of each launch in its instructions.
- An older per-project database can still be inspected with `--database PATH --history`; it is not merged into
  the global chat or its memory.
- Only one host can be open at a time on the machine for the global chat (see [0008](0008-one-writer.md)).
