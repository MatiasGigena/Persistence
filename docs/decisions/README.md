# Decisions

Short architecture decision records. Each has a status, the context, the decision and its consequences.

| ADR | Title |
|---|---|
| [0001](0001-one-global-chat.md) | One global chat |
| [0002](0002-uniichat-memory.md) | UniiChat memory instead of pi-durable compaction |
| [0003](0003-memory-only-for-pi.md) | Memory applies only to Pi |
| [0004](0004-agent-hierarchy.md) | Agent hierarchy and permissions |
| [0005](0005-background-agents.md) | Background agents, no waiting or polling |
| [0006](0006-exactly-once-delivery.md) | Exactly-once delivery across conversations |
| [0007](0007-cheap-compaction-model.md) | Cheap compaction model, size enforced by a cut |
| [0008](0008-one-writer.md) | One writer: the database flock also covers the memory |
| [0009](0009-tools-opt-in.md) | Coding tools are opt-in per launch |

To add one, copy the format (`# NNNN. Title`, then Status, Context, Decision, Consequences) with the next number.
A replaced decision keeps its file, with its status changed to "Superseded by NNNN".

Background: [memory.md](../memory.md), [agents.md](../agents.md).
