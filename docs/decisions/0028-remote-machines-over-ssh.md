# 0028. One central chat, workstation tools over native SSH

## Status

Accepted, 2026-10-21. Extends [0018](0018-tui-attach.md),
[0025](0025-protected-folders.md) and [0027](0027-standing-agents.md). Amended by
[0042](0042-routed-sends-join-their-run.md): a busy root takes a user send for its run's own destination.

## Context

The Unix-socket TUI and phone client share one server-owned chat, but their tools
run on the server. A workstation needs the same never-ending chat with tools on
its own files, without copying model credentials or starting another transcript.
A generic external MCP server or a public workstation listener adds an unnecessary
transport and permission boundary. Retrying a shell command blindly after a lost
link could repeat irreversible effects.

## Decision

### Native SSH connection

- `pi-durable connect USER@VPS --remote-bin /home/USER/pi-durable-instance/bin/pi-durable`
  saves a stable workstation `machineId` and SSH preferences in
  `~/.config/pi-durable/client.json` (or its XDG/explicit override). Optional
  `--remote-data-dir` selects the remote socket's state directory. No tool grant
  or model credentials are saved. A separate `machine-id` supports stable identity
  for one-launch destinations when no config exists.
- Interactive launches select `--remote`, then `PI_DURABLE_REMOTE`, then the saved
  SSH destination. `--local` intentionally preserves the old local chat, bypassing
  even malformed remote preferences. A failed remote launch never falls back.
- `ssh -T` uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, no forwarding, and
  the user's existing SSH configuration. Unknown host keys are refused; users
  establish and verify known hosts outside the application.
- On the server, `pi-durable bridge` proxies native NDJSON over stdio to the
  existing owner-checked mode 600 Unix socket. It starts no server, database,
  Harness, model runtime, flock, extra public port or generic external MCP server.
  The workstation likewise opens no local chat database or model runtime.
- Remote mode supports the interactive TUI only. Pipes, prompts, inspection,
  resume/plain modes and local model/auth/database launch flags are refused with
  a readable error. Admin commands still operate where invoked.

### Protocol 3 and machine capability

`welcome.machines: true` advertises routing support; the remote CLI requires it
before sending messages. `send.target` optionally carries `{machineId, cwd,
label}`. New ops `machine.register`, `machine.set`, `machine.list`, server messages
`machine.call`/`machine.cancel`, and client `machine.result` are additive in shape.
However, routed `send` now rejects busy-root user sends instead of queueing or
steering them, changing existing semantics. `PROTOCOL` therefore moves from 2 to
3; clients and server must be updated together, and older peers are refused.
See [protocol.md](../protocol.md).

A socket connection registers its exact machine and canonical cwd, with a grant
for this process only. The server requires both its coding-tools gate and that
grant. The remote CLI defaults its own coding/read tools **off**, even though
local launches and `serve` default guarded tools on (ADR 0025); `--allow-tools` or
confirmed `/tools on` grants them for this process. Another enabled connector or
a server restart cannot grant a new connector permission.

### Immutable execution scope

- Bind each user request ID and root run to one destination. Busy-root user sends
  reject rather than steer an active run onto another machine; even a rejected
  request ID cannot later change its binding.
- Spawned agents inherit the caller's pin in their creation transaction. Each
  newly delegated standing-agent session inherits the delegating run's pin;
  previous sessions and their subs keep theirs. `send_message`, reconfiguration
  and recovery do not move a session.
- Pins live separately from agent configuration. Each new agent delivery binds
  `agents:<taskId>` to its actual source session in the task-creation transaction,
  not to the standing agent's mutable current session. Report-only root runs can
  then continue and delegate review on that machine. Unmapped legacy inputs,
  conflicting destinations and old unpinned sessions fail closed, rather than
  borrowing a previous or implicit server destination.
- An offline or disabled connector leaves calls waiting for that same machine and
  exact cwd, never the server or another workstation. A dropped link does not
  cancel admitted local work. Explicit cancellation may leave partial effects.
- The initial connector supports native coding/read tools only. Remote-target
  browser and web-fetch calls refuse, never execute on the VPS as a fallback.
  Server-target sessions keep the standing agents' network kits and egress rules.

### Guarded execution and crash uncertainty

The connector executes native `read`, `write`, `edit`, `bash` through `GuardedEnv`:
local state/auth, client config directory and execution ledger hidden; system
folders read-only; bash in bubblewrap, refusing without working isolation. The
cwd pin is routing scope, not project-only filesystem confinement. Outside these
protections, tools retain the workstation user's permissions, with no per-command
approval.

Execution IDs use the durable chat namespace and tool task ID, not a connection
counter. Before effects, `machine-tools/` fsyncs an intent and payload fingerprint
in a hashed execution directory; the result is atomically written and fsynced.
Duplicate IDs join live calls or return cached results; changed payloads refuse.
An unresolved intent after a worker crash returns `INDETERMINATE`, not another
execution. Oversized results are discarded and cached as `RESULT_TOO_LARGE`.

This prevents automatic duplicate dispatch; it does **not** promise transactional
or exactly-once arbitrary bash effects. Native unsafe tool replay policy is
unchanged; a server restart may settle an execution as interrupted/unknown rather
than resume dispatch. Inspect uncertain effects before requesting a new call.
The ledger is private workstation state, not part of server chat backups; deleting
or rolling it back removes replay protection.

Graceful connector exit drains admitted calls and caches outcomes even after the
chat link detaches. An unbounded command can delay process exit; explicit stop or
cancel is not rollback. Transient normal link closes (for example after laptop
sleep) reconnect; explicit detach, revocation and incompatible protocols stop.

## Consequences

- Models, memory, agent conversations and delivery remain with the one server
  writer. Workstation model login is unnecessary for remote chat.
- Different tasks can run on different workstations without retargeting existing
  sessions. A pinned machine must reconnect in the same cwd for its tools to run.
- The workstation needs Linux, Node, SSH and working bubblewrap for bash, plus
  this checkout's dependencies. SSH and host-key setup remain the user's job.
- Remote browser/web-fetch support is deferred; the standing Researcher cannot
  fetch pages in a remote-target task yet. No fallback hides that limitation.
- Exactly-once agent message delivery remains distinct from tool side effects;
  crash uncertainty is explicit rather than silently repeating shell commands.
