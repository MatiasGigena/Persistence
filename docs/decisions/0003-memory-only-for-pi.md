# 0003. Memory applies only to Pi

## Status

Accepted, 2026-10-19

## Context

The memory is one chat: one log, one tree, one view. Agents are separate conversations with their own tasks. If
their turns went through the same extension, their steps would be logged into Pi's chat and they would compete for
one view. The recipe keeps a subagent's steps "in its own log, out of the chat".

## Decision

- The `uniichat` extension acts only when `conversationId` is the root (`ROOT_CONVERSATION_ID`).
- Spawned agents copy Pi's choices, then the host's `childAgent` change removes the extension:
  `{ extensions: { remove: [Unii] } }`. They have no `zoom` or `date` tool and no view-based request.
- An agent's first input starts with Pi's view at spawn time (`initialContext: () => memory.render()`).
- Reports that reach Pi are logged in its memory as `work` messages; Pi reads an agent's whole chat with
  `zoom("Name")`.

## Consequences

- Pi's memory holds what agents report to Pi, not their tool steps.
- An agent sees its own plain conversation. With pi-durable compaction off for all conversations
  ([0002](0002-uniichat-memory.md)), nothing bounds a long agent conversation.
- An agent does not see Pi's later view; it can ask Pi (mains only) or read `last_message("Pi")`.
