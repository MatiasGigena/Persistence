# 0014. A compact terminal layout below 60 columns, for phones

## Status

Accepted, 2026-10-19

## Context

The host runs on a server in tmux, and is often reached from a phone over SSH or mosh. A phone in portrait
gives 40 to 60 columns and, with the keyboard open, about 15 rows. At that size the terminal UI of ADR 0012
truncated its footer from the right (losing the tools state), spent rows on a header that repeats the footer,
and let pi-tui's editor grow to 5 lines plus borders, half the screen. Tool calls showed a JSON blob, panels
kept 2-column margins, and phone keyboards often have no Esc key, the only way to interrupt Pi. Every spinner
frame is also a network write.

## Decision

- Below 60 columns (`NARROW` in `src/ui/tui/theme.ts`) each part of the TUI uses a compact form; above it,
  the wide layout stays as it was. The switch is per render, from the width, so a rotated phone follows.
- The footer keeps segments in priority order (working, tools, queued, agents, model, memory failures, memory
  size, thinking, summaries) until one does not fit; the tools state is never dropped. It applies at every
  width, so a wide footer that does not fit drops its least useful segments instead of being cut.
- Tool calls show their status mark, name and one meaningful argument (`toolSummary`), at every width.
- The editor shows at most about 30% of the rows, by trimming pi-tui's rendered window around the cursor,
  since pi-tui's own limit has a 5-line floor.
- `/stop` does what Esc does. Ctrl+D and Ctrl+C twice ask before exiting while Pi or an agent works; `/exit`
  does not ask.
- The spinner ticks every 250 ms instead of 80 ms when `SSH_CONNECTION` is set or the terminal is narrow.

## Consequences

- The session contract (`src/ui/types.ts`) is unchanged; all of this lives in `src/ui/tui/`.
- Panel margins and the confirmation box's width are chosen when the overlay opens, so a resize while one is
  open keeps its old margins until it is reopened.
- The editor's window trim is outside pi-tui: a mouse click inside a trimmed multi-line draft can land on
  the wrong line.
- The tmux and mosh settings that make keys and colors work are documented in `docs/operations.md`.
