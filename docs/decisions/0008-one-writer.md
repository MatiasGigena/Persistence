# 0008. One writer: the database flock also covers the memory

## Status

Accepted, 2026-10-19

## Context

The memory log is append-only and its ids must be contiguous; `view.json` is rewritten on every change. Two
processes writing the same memory directory would interleave ids and lose views. pi-durable's SQLite database
already needs a single host process.

## Decision

- `src/cli.mjs` runs the host under `flock --nonblock --conflict-exit-code 75 --no-fork <database>.lock`. A second
  launch exits with code 75 and `This database is already open in another pi-durable process.`
- The memory directory is derived from the database path (`chat.sqlite` → `chat.unii`), after `realpath`, so the one
  lock covers both, also through a symlinked `--database`.
- Inside a process, `openMemory` refuses a second open of the same directory.
- `--status` and `--history` also take the lock but do not open the memory.

## Consequences

- No separate lock file or lock protocol for the memory.
- Only one host per chat at a time, including inspection commands.
- Requires `flock` (util-linux). Copying or moving the chat means moving the database and its `.unii` directory
  together.
