# 0012. A full-screen terminal UI on pi-tui, as a client of the event stream

## Status

Accepted, 2026-10-19. Amended by [0016](0016-server-mode.md) and [0018](0018-tui-attach.md): the terminal UI also attaches to a running server.

## Context

The chat was a `readline` loop: plain text, answers printed only when complete, no
view of tool calls, agents, or memory. The host runs in a terminal, often over SSH in
tmux on a VPS, and deliberately opens no network port. Pi's own UI library,
`@earendil-works/pi-tui`, was already installed through pi-coding-agent, and
pi-durable's `watchEvents()` emits Pi-style events (streamed text and thinking, tool
calls, inbox and run changes).

## Decision

- The interactive chat is a TUI built with `pi-tui` 1.3.0, pinned as a direct
  dependency.
- It is split in three parts behind one contract, `src/ui/types.ts`:
  `src/ui/session.ts` turns events, memory and agents into `ChatItem`s and a
  `SessionStatus`; `src/ui/tui/` renders them; the TUI never touches pi-durable.
- It uses pi-tui's alternate-screen renderer, as Pi does by default: the chat
  scrolls while the footer and editor stay pinned, and on exit the transcript is
  printed to the normal screen so it stays in scrollback.
- `/agents` and `/mem` are overlays: live agent chats, and a browser over the
  memory view that zooms down the tree.
- `--plain` keeps the readline chat. `-p`, piped stdin, `--history`, `--status`
  and `--resume` do not use the TUI.

## Consequences

- Shutdown keeps its guarantees: signals abort the TUI, restore the terminal, then
  close the harness without discarding durable work.
- During a session, native terminal scrollback is not used; PgUp/PgDn and the mouse
  wheel scroll the chat instead.
- A web client could later attach to the same session layer (for example over an
  SSH tunnel) without a public port; the contract does not depend on the terminal.
- The agents panel has its own compact chat renderer, which duplicates part of
  `src/ui/tui/chat.ts`; they can be merged later.
