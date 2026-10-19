# 0019. Private access over Tailscale, and the remote tools policy

## Status

Access accepted, 2026-10-19 (phase 4: `src/server/auth.ts`, `src/server/transport-ws.ts`); the tools policy proposed. Amends [0009](0009-tools-opt-in.md).

## Context

The server ([0016](0016-server-mode.md)) is reached from a phone. Whoever reaches it can run Pi, read the whole
chat, and, with coding tools on, run commands as the owner on the VPS. The owner's phone is on a tailnet with the
VPS; `tailscale serve` gives HTTPS on the tailnet and tells the backend who the tailnet user is. Coding tools are
opt-in per launch ([0009](0009-tools-opt-in.md)), but a server's launch lasts for weeks, and its user is not at a
terminal to pass `--allow-tools`.

## Decision

Access, all of these together:

- The server binds loopback only: `127.0.0.1:<port>` (default 7433) and the mode 600 Unix socket. `tailscale serve`
  proxies tailnet HTTPS to the port.
- `Tailscale-User-Login` must be in `PI_DURABLE_ALLOW_LOGIN`.
- A device pairs once with a one-time code from `pi-durable serve pair` and gets a `pd_device` cookie
  (`HttpOnly; Secure; SameSite=Strict`); the server stores only its sha256, in `serve/devices.json`.
  `serve devices --revoke NAME` forgets one and closes its connections.
- `Origin` must equal `PI_DURABLE_ORIGIN` on the WebSocket upgrade and every non-GET request.
- Without `PI_DURABLE_ORIGIN` and `PI_DURABLE_ALLOW_LOGIN`, the server has no web listener at all.

Tools:

- `serve` always starts with coding tools off, and refuses `--allow-tools`.
- A client may turn them on with `tools.set` and `confirm: 'enable-tools'`, sent only after its user confirmed.
  `PI_DURABLE_REMOTE_TOOLS=off` (default `confirm`) keeps web clients from turning them on; terminal clients on the
  socket always may.
- After `PI_DURABLE_TOOLS_IDLE_MIN` minutes (default 30) without a run of Pi or an agent, the server turns them off.
- Every change is broadcast to all clients as a notice naming who made it, and written to the journal.
- The choice is still never saved: a server restart starts with them off again.

## Consequences

- Reaching the server takes the tailnet, an allowed login, and a paired device; a local user of the VPS who can
  forge the header still lacks a device cookie. The VPS is assumed to have one user.
- [0009](0009-tools-opt-in.md)'s "every launch starts with the tools off" holds for the server; "enabled for the
  launch" becomes "enabled until idle for 30 minutes, or until turned off".
- A phone left with tools on cannot leave them on overnight unnoticed: they turn off when the work stops.
- New invariant (AGENTS.md): no unauthenticated listener: loopback TCP or a 0600 Unix socket only.
