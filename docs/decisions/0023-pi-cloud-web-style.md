# 0023. Match the Pi Cloud web style

## Status

Accepted, 2026-10-20, at the user's request. The menu part is amended by [0026](0026-pi-cloud-chat-controls.md).

## Decision

Use `MatiasGigena/Pi-Cloud` at `ff6f72c` as the visual reference for the web app:
black monochrome surfaces, monospace type, glass chrome, rounded controls, the Pi
block mark and inline Lucide 1.49.0 icons (licence included in `index.html`). The
installed app and offline page use the same dark colours regardless of OS theme.

The existing menu stays on the right with its right-hand trigger, following the
user's latest decision: no left drawer. Use a rounded monochrome glass popover,
a labelled header and close button, and scroll within the viewport on small or
short screens. Keep the existing Agents, Memory, Model, Coding tools, Settings
and Stop all actions and behaviour; do not add Pi Cloud's workspaces, sessions,
workflow controls or swipe gestures. Retain the native dialog focus trap,
Escape/backdrop dismissal and accessible buttons.

No framework, runtime dependency, protocol, agent, security, storage or chat-flow
change. The terminal UI is unaffected. Existing viewport, keyboard, safe-area,
reduced-motion and tool-confirmation handling remain in place.
