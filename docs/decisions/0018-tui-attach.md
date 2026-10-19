# 0018. The terminal UI attaches to a running server

## Status

Accepted, 2026-10-19. Amends [0012](0012-terminal-ui.md) and [0014](0014-phone-layout.md).

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
- The link (`unix-link.ts`) checks the socket's owner, then wants the `welcome` within 1.5 s: that is the probe,
  and a launch that gets no welcome takes the local path (a busy flock then prints "A server runs this chat; run
  `pi-durable` to attach" when the socket answers by then). Once attached it pings every 20 s, drops a link
  silent for 40 s, and reconnects from 0.25 s doubling to 5 s (±20%): the server is on the same machine, so a
  restart is back within seconds. `bye` 1000, 4000 and 4001 end it for good, with the reason as a notice.
- `RemoteSession` (`remote-session.ts`) mirrors feeds with `applyOps` (a mismatch asks `feed.resync`), keeps the
  last status, and turns each method into a request with a 30 s timeout. Requests pending on a drop reject
  ("Connection to the server lost"), except `send`: it carries a requestId and is resent on the next
  connection, so a message typed during a blip arrives once. Every reconnect starts from a fresh snapshot, and
  re-opens the agent feeds that were open; a changed `boot` shows "The server restarted.". `setTools(true)` sends
  `confirm: 'enable-tools'`, since the TUI asked first.
- After a detach the CLI prints "Detached; the server keeps working." and exits 0; when the server closed the
  link for good it exits 1.
- The `/mem` panel loads the view asynchronously, shows `Loading…`, and reloads it while open whenever the
  status's memory counters change; each zoom opens its level at once and fills it in.

## Consequences

- The TUI has no in-process shortcut left: everything it shows comes through the contract, also locally.
- The status's agents no longer carry conversation IDs (`AgentStatus`); `src/ui/types.ts` imports nothing, so the
  browser can type-check against it.
- A detached terminal leaves Pi and agents working on the server; `/exit` no longer means "stop the work" there.
