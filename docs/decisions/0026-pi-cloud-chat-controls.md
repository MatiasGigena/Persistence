# 0026. Pi Cloud's chat settings, turn actions and steering in the web app

## Status

Accepted, 2026-10-20, at the user's request. Amends [0023](0023-pi-cloud-web-style.md).
Pi Cloud, a private project, has since been retired; the controls stay.

## Context

0023 kept the web app's own menu (Agents, Memory, Model, Coding tools, Settings, Stop all) behind a "⋯" button,
with model and effort chips in the header, and a separate stop button. The user asked for the right-hand menu to
be Pi Cloud's (a retired private project) with the unneeded parts removed, for Pi Cloud's copy actions,
and for its send flow: while Pi works, a typed message steers it and the same button stops it when the box is empty.

## Decision

- **Chat settings.** The header's right button is Pi Cloud's sliders icon and opens "Chat settings" in the existing
  sheet: Model and Thinking as two labelled selects, switches for Coding tools (still confirmed first, still for the
  run only) and this device's notifications, and rows into Agents and Memory. Removed: the "⋯" menu, the model and
  effort chips (the header shows `model · level` as quiet text), the Settings panel's device and full-status
  sections, and Stop all (each agent's view keeps its own stop).
- **Copy.** As Pi Cloud: the last finished assistant message of each turn gets a copy button for its Markdown text,
  and every code block (fenced code in a message or report, a bash call's command, a tool's arguments and output)
  gets one in its corner. A check shows once copied; an alert when the browser refuses.
- **Send, steer, stop.** One round button. Idle, it sends. While Pi works, the placeholder reads "Steer Pi…": with
  text, the button shows a steer icon (Lucide `corner-up-right`) and sends it with `steer: true`, so Pi takes it
  between its steps; with an empty box, it is a stop button (`abort`), disabled while the abort is in flight. Stop
  never shows while a send is unadmitted, for 600 ms after a send (so a double tap cannot abort what it just sent),
  or while the link is not ready. Enter on a keyboard only ever sends. The pending bubble says "Steering".
- **Protocol.** `send` takes an optional `steer` boolean, passed to pi-durable as `whenBusy: 'steer'`. It is
  additive, so `PROTOCOL` stays 2; a server that ignores it follows the message up instead.

## Consequences

Stopping every agent at once is no longer one tap on the phone; the terminal and each agent's view still do it.
Pi Cloud's follow-up button, toolbar, sessions and workspaces stay out, as in 0023. The terminal UI is unchanged.
