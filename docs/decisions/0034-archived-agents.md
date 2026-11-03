# 0034. Archive ad-hoc agents; archived agents are deleted after a day

## Status

Accepted, 2026-10-21, at the user's request; numbered 0034 when it was integrated after Pi's `delete_agent`.
Amends [0027](0027-standing-agents.md).

## Context

With the standing roster (ADR 0027), the main agents Pi made up before it, and the ones it still makes, clutter
`/agents`, the web app's Agents panel, `list_agents` and Pi's "agents at work". Pi keeps `spawn_agent`; the user wants
to clear the others away by hand, and have them gone for good a day later.

## Decision

### Archiving

- The user archives an agent: one by name, or every ad-hoc main agent at once. Standing agents cannot be archived
  (`Coder is a standing agent; remove it from the roster first.`). Archiving a main agent archives its sub agents
  with it; a sub agent may be archived on its own.
- Archiving stops the agent's work (as `stop_agent`, every session) and records `archivedAt` (milliseconds since the
  epoch) on its registry record, in one commit.
- An archived agent is hidden from `/agents`, the web app's Agents panel (except its "Archived" section),
  `list_agents`, `atWork` and status counts. Nothing can reach it: `send_message`, `last_message`, `stop_agent` and
  `spawn_agent` with its name refuse (`Helper is archived; it is deleted at <ISO time>.`); deliveries to it complete
  without submitting, and its reports go nowhere. `zoom("Name")` still reads it while archived.
- **Restore**, while archived, clears `archivedAt` (and its subs', when restoring a main agent). It does not resume
  stopped work.

### Deletion after a day

- An agent archived for 24 hours or more is deleted: its registry record (and its subs') is removed, so its name is
  free again. As with Pi's `delete_agent`, the registry's `deleted` map keeps its conversations' ids, so
  `zoom("Name")` still reads its chat. Its browser profile (`chat.unii/browser/<name>/`) is deleted too, so a new agent given the name does not inherit its
  logins.
- The host sweeps at every work launch and then hourly while it runs, in one commit per sweep, under the one writer.
  A host that is closed for longer deletes overdue agents at its next launch.
- pi-durable has no API to delete a conversation, so the conversation's rows stay in `chat.sqlite`, unreferenced.
  Deletion is logical: only `zoom` reads them again. Reclaiming the space is left for later.
- Any delivery still pending for a deleted agent completes without submitting, as for an unknown conversation.

### Where the user archives

- Terminal UI: the `/agents` panel archives the selected agent, archives all ad-hoc agents, and lists archived
  ones with their deletion time and a restore action.
- Web app: the same in the Agents sheet.
- Protocol: new ops `agents.archive` (`{ name }` or `{ adhoc: true }` → `{ names }`) and `agents.restore`
  (`{ name }` → `{ names }`), both peers; `SessionStatus.agents` entries gain an optional `archivedAt`. The field is optional, but
  `status.agents` now lists archived agents too, which an older client would show as active: `PROTOCOL` goes to 4.
- Server CLI: `pi-durable serve agents` lists agents; `--archive NAME`, `--archive-adhoc` and `--restore NAME` call
  the ops over the socket.
- Pi has no tool for it; its `delete_agent` deletes an idle ad-hoc agent at once, while archiving can be undone for a
  day.

### Persisted names

New and frozen once shipped: the registry field `archivedAt`; the protocol ops `agents.archive` and `agents.restore`.

## Consequences

- An archived agent's work is lost a day later; restoring within the day keeps its chat.
- Disk space of deleted agents' conversations is not reclaimed.
