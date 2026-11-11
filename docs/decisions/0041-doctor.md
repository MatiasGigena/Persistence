# 0041. `pi-durable doctor`

## Status

Accepted, 2026-11-10.

## Context

One chat now spans several machines: a server that runs it, workstations that run its tools over SSH, a phone. Each
needs its own prerequisites: bubblewrap for bash, Chromium for the Reviewer's browser, Pi's login and the `claude`
CLI's, the autoreview skill and the Codex CLI where reviews run, a known SSH host key, the web app's two settings.
A missing one showed up late and far from its cause: as a launch warning in a journal nobody was reading, or as a
tool call that failed in the middle of a task. The operations guide has a troubleshooting table, which helps once
the symptom is known.

## Decision

- `pi-durable doctor` runs every check that can be automated and prints one line per check: `ok`, `warn`, `FAIL` or
  `skip` (a check that does not apply here, with the reason), what was found, and under a `warn` or `FAIL` a `Fix:`
  line with a command or the section of the operations guide. It exits 1 when a check FAILs. `--json` prints the
  checks as an array of `{id, level, subject, detail, fix?}`.
- It only reads, and takes no lock: no flock, no database connection, no memory load, no model request, nothing
  created, not even the data directory or Pi's `auth.json` (its model runtime gets a credential store that refuses
  writes). So it is safe beside a running server, and on a machine with nothing installed yet. The CLI dispatches it
  before remote selection and before the Node version check, which is its first line.
- A check calls what a launch itself calls: `sandboxProblem` for bubblewrap, the settings and roster readers,
  `catalogProblem`, `checkAccess` and `accessProblem` for the model, `rosterWarnings` for the standing agents,
  `serveSettings` for the server's environment, the SSH link's own options for the login probe. The two cannot
  disagree, and a new launch check reaches the doctor without being written twice.
- Checks run at once, each under its own time limit (5 s; a check over it is a `warn` saying so), and are listed in
  a fixed order: Node, flock, bubblewrap, Pi's SSH keys, `settings.json`, the launch model, the standing agents,
  autoreview, the chat's files, the memory directory, backups, the saved remote, the server's web settings.
- On a workstation with a saved remote, the checks of what the server needs (the model, the standing agents,
  backups) are skipped, naming the server; `--local` checks this machine's own chat instead.
- The SSH login is tried only with `--remote-check`: it is the one check that leaves the machine. It runs `true`
  with the link's options (no prompt, strict host keys, no forwarding).

## Consequences

- A warning is what a launch would only warn about (a standing agent that cannot browse, no backup); a FAIL is what
  stops a launch or a tool (no bubblewrap, no credentials for the model).
- It does not check what needs the chat open or another service's state: that the database is intact, that
  `tailscale serve` is configured, that push reaches the phone, that the remote server's own install is healthy
  (run `doctor` there). The troubleshooting table still covers those.
- `doctor` is a subcommand, so a prompt whose first word is `doctor` needs `-p`, as `serve`, `backup`, `connect` and
  `bridge` do.
