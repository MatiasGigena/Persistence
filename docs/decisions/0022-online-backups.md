# 0022. Online backups

## Status

Accepted, 2026-10-19.

## Context

Backups today mean stopping the host and copying `chat.sqlite*` and `chat.unii/`
([operations.md](../operations.md#backups)). A server runs for weeks, so stopping it daily is not an option. The
user wants a daily backup on the VPS, kept 14 days. Only the writer may touch the database
([0008](0008-one-writer.md)), and the memory must not be ahead of the database it belongs to.

## Decision

- `pi-durable backup [--out DIR]` writes a new directory under `DIR` (default `backups/` beside the database)
  holding `chat.sqlite`, `chat.unii/` and `settings.json`.
- The writer makes it: the running server, through `admin.backup` on its socket; without a server, the command
  takes the flock and does it itself.
- `chat.sqlite` comes from `VACUUM INTO`, a consistent copy that needs no pause; then `chat.unii/` is copied. Both
  run synchronously in one turn of the writer's event loop, so no commit or memory append lands between them.
- `contrib/systemd/pi-durable-backup.{service,timer}` runs it daily and deletes backups older than 14 days.

## Consequences

- Backups need no downtime and are restorable by copying the directory into place.
- The event loop blocks for the copy: seconds for a large `.unii`, once a day.
- A backup is the whole chat in clear; it stays on the VPS, mode 700, like the data dir.

## Implementation notes

- The runtime opens SQLite through a subclass of pi-durable's `NodeSqliteDatabase` that adds `exclusive(step)`:
  `step` runs with the raw `DatabaseSync` as one operation of the adapter's queue, after any open transaction.
  `backup.ts` runs `VACUUM INTO` and the `.unii` and `settings.json` copies inside that step, synchronously, so
  neither a commit nor a memory append (both need the event loop) lands between them.
- Backups go to `<out>/<UTC time>/` (`2026-10-19T03-00-00Z`), mode 700, every file and directory fsynced. Pruning
  deletes only directories named that way, older than 14 days, in the same `out`.
- Without a server, `host.ts` runs the backup under the CLI's flock with a direct `DatabaseSync`; no model
  credentials are needed.
