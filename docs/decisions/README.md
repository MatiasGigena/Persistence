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
| [0009](0009-tools-opt-in.md) | Coding tools are opt-in per launch (superseded by 0025) |
| [0010](0010-claude-via-cli.md) | Claude through the official CLI, which only proposes tool calls |
| [0011](0011-typescript-without-build.md) | Strict TypeScript without a build step |
| [0012](0012-terminal-ui.md) | A full-screen terminal UI on pi-tui, as a client of the event stream |
| [0013](0013-saved-default-model.md) | A model chosen in session is saved as the default, beside the database |
| [0014](0014-phone-layout.md) | A compact terminal layout below 60 columns, for phones |
| [0015](0015-agent-compaction.md) | pi-durable compacts agents; Pi's compactions stay declined |
| [0016](0016-server-mode.md) | Server mode: one headless host that clients attach to |
| [0017](0017-wire-protocol.md) | Wire protocol: JSON messages, state synced by item id diffs |
| [0018](0018-tui-attach.md) | The terminal UI attaches to a running server |
| [0019](0019-private-access.md) | Private access over Tailscale, and the remote tools policy (amends 0009; tools policy superseded by 0025) |
| [0020](0020-web-client-without-build.md) | A web client without a build step (extends 0011) |
| [0021](0021-web-push-on-node-crypto.md) | Web Push on node:crypto |
| [0022](0022-online-backups.md) | Online backups |
| [0023](0023-pi-cloud-web-style.md) | The web app follows Pi Cloud's style (a retired private project) |
| [0024](0024-saved-effort.md) | Reasoning effort is chosen in session and saved like the model |
| [0025](0025-protected-folders.md) | Coding tools on by default everywhere, held to protected folders (supersedes 0009) |
| [0026](0026-pi-cloud-chat-controls.md) | Chat settings, turn actions and steering in the web app, after Pi Cloud's (amends 0023) |
| [0027](0027-standing-agents.md) | Standing agents with their own models, tools and a session per task (amends 0003) |
| [0028](0028-remote-machines-over-ssh.md) | One central chat, workstation tools over native SSH (extends 0018, 0025, 0027) |
| [0029](0029-reviewer-autoreview-p2.md) | Reviewer always uses the installed autoreview skill through a dedicated P2 tool |
| [0030](0030-pi-ssh-agent.md) | bash sees Pi's own SSH agent, never the user's (amends 0025) |
| [0031](0031-chat-images.md) | Images in the chat: pasted screenshots in, existing image files out |
| [0032](0032-web-shell-stale-while-revalidate.md) | The web app starts from whole cached versions of its files, revalidated in the background |
| [0033](0033-code-mode.md) | Code mode: one script coordinates several tool calls, each with its own protections |
| [0034](0034-archived-agents.md) | Archive ad-hoc agents; archived agents are deleted after a day (amends 0027) |
| [0035](0035-pi-1-5-0.md) | Pi 1.5.0: conversation views instead of events, pi-schema tools, a one-way chat migration (amends 0012) |
| [0036](0036-shared-code-homes.md) | One home for code that several layers share (amends 0020) |
| [0037](0037-pi-1-5-2.md) | Pi 1.5.2: Chord's foundations from their subpaths, one `SDK` constant, no migration |
| [0038](0038-scheduled-wake-ups.md) | Scheduled wake-ups: Pi leaves itself a message for later, once or on a cron (extends 0005, 0006) |

To add one, copy the format (`# NNNN. Title`, then Status, Context, Decision, Consequences) with the next number.
A replaced decision keeps its file, with its status changed to "Superseded by NNNN".

Background: [memory.md](../memory.md), [agents.md](../agents.md), [models.md](../models.md).
