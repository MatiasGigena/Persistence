# 0023. Match the Pi Cloud web style

## Status

Accepted, 2026-10-20, at the user's request.

## Decision

Use `MatiasGigena/Pi-Cloud` at `ff6f72c` as the visual reference for the web app:
black monochrome surfaces, monospace type, glass chrome, rounded controls, the Pi
block mark and inline Lucide 1.49.0 icons (licence included in `index.html`). The
installed app and offline page use the same dark colours regardless of OS theme.

The menu becomes a left-side drawer with a hamburger trigger and close button,
matching Pi Cloud's mobile navigation. Keep Persistence's existing menu actions;
do not add Pi Cloud's workspaces, sessions or workflow controls. Retain native
dialog focus trapping and Escape/backdrop dismissal.

No framework, runtime dependency, protocol, agent, security, storage or chat-flow
change. The terminal UI is unaffected. Existing viewport, keyboard, safe-area,
reduced-motion and tool-confirmation handling remain in place.
