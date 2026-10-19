# 0018. The terminal UI attaches to a running server

## Status

Proposed, 2026-10-19. Amends [0012](0012-terminal-ui.md) and [0014](0014-phone-layout.md).

## Context

With a server running ([0016](0016-server-mode.md)), a launch in a shell on the VPS cannot take the flock, so it
cannot open the chat itself. The terminal UI knows the host only through `UiSession`, so it can run on a session
that lives in another process, if the contract allows a session that answers over a link.

## Decision

- `UiSession` changes: `memoryView()` and `zoom()` return promises; `onNotice(listener)` carries host notices
  (warnings, tool switches by other clients) to every client. In process, the host's console warnings go through
  `UiSessionHandle.notify()` while the TUI runs.
- `src/client/remote-session.ts` implements `UiSession` over the protocol; `unix-link.ts` is its socket transport;
  `attach.ts` probes the socket (checking it is owned by the user) and runs the TUI on the remote session.
- An interactive launch attaches when the probe finds a server; `--local` never attaches; `--attach` fails without
  a server. Attaching refuses launch settings (`--allow-tools`, `--model`, `--thinking`, `--cwd`, `--auth-file`,
  `--plain`): the server's apply, and `/model` and `/tools` change them.
- `TuiInfo.attached` (`state()`, `onChange()`) tells the TUI it is attached: `/exit`, Ctrl+D and Ctrl+C twice
  detach at once, without the busy confirmation (the server keeps working); help and `/exit` say "detach"; the
  footer shows `reconnecting…` (never dropped, like the tools state) while the link is down; when it closes for
  good, the TUI leaves a notice and exits.
- The `/mem` panel loads the view asynchronously, shows `Loading…`, and reloads it while open whenever the
  status's memory counters change; each zoom opens its level at once and fills it in.

## Consequences

- The TUI has no in-process shortcut left: everything it shows comes through the contract, also locally.
- The status's agents no longer carry conversation IDs (`AgentStatus`); `src/ui/types.ts` imports nothing, so the
  browser can type-check against it.
- A detached terminal leaves Pi and agents working on the server; `/exit` no longer means "stop the work" there.
