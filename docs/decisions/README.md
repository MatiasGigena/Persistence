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
| [0007](0007-cheap-compaction-model.md) | Cheap compaction model, size enforced by a cut (amended: fresh-call retry, refusals clip) |
| [0008](0008-one-writer.md) | One writer: the database flock also covers the memory |
| [0009](0009-tools-opt-in.md) | Coding tools are opt-in per launch (amended: `/tools` in session) |
| [0010](0010-claude-via-cli.md) | Claude through the official CLI, which only proposes tool calls |
| [0011](0011-typescript-without-build.md) | Strict TypeScript without a build step |
| [0012](0012-terminal-ui.md) | A full-screen terminal UI on pi-tui, as a client of the event stream |
| [0013](0013-saved-default-model.md) | A model chosen in session is saved as the default, beside the database |
| [0014](0014-phone-layout.md) | A compact terminal layout below 60 columns, for phones |
| [0015](0015-agent-compaction.md) | pi-durable compacts agents; Pi's compactions stay declined |

To add one, copy the format (`# NNNN. Title`, then Status, Context, Decision, Consequences) with the next number.
A replaced decision keeps its file, with its status changed to "Superseded by NNNN".

Background: [memory.md](../memory.md), [agents.md](../agents.md), [models.md](../models.md).
