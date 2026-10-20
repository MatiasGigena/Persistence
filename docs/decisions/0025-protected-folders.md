# 0025. Coding tools on by default everywhere, held to protected folders

## Status

Accepted, 2026-10-20. Amends [0009](0009-tools-opt-in.md) and the tools half of [0019](0019-private-access.md).

## Context

The server started with the coding tools off and turned them off after 30 idle minutes, and every server restart
turned them off again. Agents copy Pi's tools, so with them off an agent cannot change code either. In practice the
user turned them on from the phone after nearly every restart. What the off state guarded against was the tools
damaging what matters most on the machine: the chat's own state and the user's credentials. Those can be
protected directly instead.

## Decision

- `serve` starts with the coding tools on, like a local launch; `--no-tools` turns them off for either.
  `/tools` and the web toggle still switch them for the current run, never saved.
- No idle switch-off by default. `PI_DURABLE_TOOLS_IDLE_MIN=N` brings it back; `welcome.tools.idleMinutes` is
  absent without it, which made the protocol 2.
- Protected folders, for Pi and every agent (`src/runtime/guard.ts`, an `ExecutionEnv` around pi-durable's):
  - Hidden, neither read nor written: the chat's state (the data directory, the database with its WAL, lock and
    socket, the `.unii` memory, `settings.json`, `serve/`, `backups/`), Pi's `auth.json`, and credentials under the
    home directory (`~/.ssh`, `~/.gnupg`, `~/.claude`, `~/.claude.json`, `~/.config/gh`, `~/.aws`, `~/.azure`,
    `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`,
    `~/.pypirc`).
  - Read-only: `/etc`, `/usr`, `/boot`, `/opt`, `/bin`, `/sbin`, `/lib*`, `/srv`, `/var/lib`.
  - `PI_DURABLE_PROTECT` adds hidden paths and `PI_DURABLE_UNPROTECT` removes defaults (`:`-separated, `~` allowed).
- Enforcement:
  - `read`, `write` and `edit` go through the guarded environment, which resolves symlinks and refuses with
    `permission_denied` (and the path) anything under a hidden path, writes under a read-only one, and removing or
    renaming a folder that contains a protected path.
  - Every bash command runs in bubblewrap (`bwrap --dev-bind / /`, hidden folders as an empty tmpfs, hidden files
    unreadable, read-only folders bound read-only). Without a working bubblewrap, bash refuses to run and says how
    to install it; the host and the server say so at start too.
- Pi's instructions name the protected folders and ask it not to work around a refusal.

## Consequences

- A turn that needs a credential fails where it needs it: `git push` over SSH, `gh`, cloud CLIs. The user decides
  per path with `PI_DURABLE_UNPROTECT`.
- The protection is against mistakes and prompt injection by the model, not against the user: anything outside the
  list keeps the user's permissions, network included. A path that does not exist at launch is refused to read,
  write and edit, but bash can create it.
- bubblewrap is a new runtime requirement for bash (Linux only). It needs unprivileged user namespaces.
- Protocol 2: an older web page or attached TUI is refused with 4000 and reloads (web) or asks for an update.
