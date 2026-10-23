# 0030. bash sees Pi's own SSH agent, never the user's

## Status

Accepted, 2026-10-23. Amends [0025](0025-protected-folders.md).

## Context

ADR 0025 hides `~/.ssh`, but bash still inherited `SSH_AUTH_SOCK`, and the user's agent was reachable in the
sandbox. An agent signs with every key it holds, so Pi could use any loaded key (a server's included) without
reading a key file. GNOME Keyring's folder (`$XDG_RUNTIME_DIR/keyring`, its SSH agent and secrets) and gpg-agent's
sockets (`$XDG_RUNTIME_DIR/gnupg`, its SSH agent included) were reachable the same way. Meanwhile `git push` over
SSH failed anyway, at host key verification, since `~/.ssh/known_hosts` is hidden too.

## Decision

- Hidden like a credential: the socket `SSH_AUTH_SOCK` names, `$XDG_RUNTIME_DIR/keyring` and
  `$XDG_RUNTIME_DIR/gnupg` (`protection()`, `src/runtime/guard.ts`). bash runs with `SSH_AGENT_PID` unset.
- `PI_DURABLE_SSH_KEYS` (`:`-separated key files, `~` allowed) gives Pi an agent of its own
  (`src/runtime/ssh-agent.ts`): `openInstance` starts `ssh-agent -D` on a socket in a fresh private folder under
  `XDG_RUNTIME_DIR` (else `/tmp`), adds those keys with `ssh-add`, and closes it with the Instance. bash gets that
  socket as `SSH_AUTH_SOCK`; without the variable it has none. The key files stay hidden. An SSH connector does the
  same on its workstation (`src/client/remote.ts`), from the variable in its own launch environment.
- `ssh-add` runs without a terminal and with `SSH_ASKPASS_REQUIRE=never`, so a key with a passphrase is not added;
  the launch warns about it, and about an agent that cannot start, without failing.
- Host keys come from outside the hidden folder: the system's `/etc/ssh/ssh_known_hosts` (read-only to the tools).
- The session D-Bus stays reachable: hiding it would break ordinary tools.

## Consequences

- Pi can push with the keys the user chose and no others; a key for GitHub alone limits it to what that key may do.
- A host killed with SIGKILL leaves its `ssh-agent` running until logout clears `XDG_RUNTIME_DIR` or the user kills
  it; the socket is in a 0700 folder.
- The keyring's secrets may still be reachable through D-Bus (Secret Service): not verified, and not closed here.
