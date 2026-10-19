# 0002. UniiChat memory instead of pi-durable compaction

## Status

Accepted, 2026-10-19. Amended by [0015](0015-agent-compaction.md): pi-durable's compaction is on again, for
agents only; the extension still declines Pi's.

## Context

pi-durable keeps the whole transcript and, by default, compacts a conversation when it nears the context window:
older history is replaced by a summary. In a chat that never ends, that repeats forever, loses detail each time,
and changes the prompt prefix at every compaction.

Victor Taelin's UniiChat recipe instead logs every message and builds a binary tree of 512-byte summaries in the
background. Each request sees a view of that tree that stays between 64 and 128 KB, and the model can `zoom` into any
line, down to the message.

## Decision

- Pi's context is the UniiChat view, built by the `uniichat` extension in `src/memory/`
  (see [memory.md](../memory.md)).
- pi-durable's compaction is off: the Harness gets `settings: { compaction: { enabled: false } }`, and the extension
  also declines any compaction of the root (`beforeCompact` returns `{ decline: true }`).
- pi-durable still stores the full transcript; the memory is a separate log beside the database.

## Consequences

- Pi's context has a bounded size and nothing is lost: every message can be read whole with `zoom(id, 1)`.
- The memory costs background model calls (one per long message or merge) and a second copy of the chat on disk.
- The setting applies to every conversation, so spawned agents are not compacted either (see [0003](0003-memory-only-for-pi.md)).
