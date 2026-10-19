# Operations

How to install, run, back up, move, and remove a Persistence host.

## Requirements

- Linux, Bash, and `flock` (usually from util-linux).
- Node.js 22.19 or newer. The launcher uses `PI_DURABLE_NODE` if set, else `node`
  on PATH. If that `node` is older than 22.19, it falls back to Pi's private Node at
  `~/.local/share/pi-node/current/bin/node` when present.
- No root privileges, Docker, open inbound port, or public web server.

## Install locally

```sh
git clone git@github.com:MatiasGigena/Persistence.git ~/pi-durable-instance
cd ~/pi-durable-instance
npm ci --ignore-scripts
npm run check && npm test
mkdir -p ~/.local/bin
ln -s "$HOME/pi-durable-instance/bin/pi-durable" "$HOME/.local/bin/pi-durable"
```

If that link already exists, inspect it instead of overwriting it. Make sure
`~/.local/bin` is on PATH, or call `~/pi-durable-instance/bin/pi-durable` directly.
Always launch through `bin/pi-durable` (or `src/cli.mjs`), never `src/host/host.mjs`:
the host relies on the CLI for the lock.

## Install on a VPS

Copy the application, not your credentials or `node_modules`:

```sh
# On this computer (replace USER and VPS):
rsync -a --exclude node_modules/ ~/pi-durable-instance/ USER@VPS:~/pi-durable-instance/
ssh USER@VPS

# On the VPS:
cd ~/pi-durable-instance
npm ci --ignore-scripts
npm run check && npm test
mkdir -p ~/.local/bin
ln -s "$HOME/pi-durable-instance/bin/pi-durable" "$HOME/.local/bin/pi-durable"

npm exec -- pi
# In Pi: /login, then exit

cd /path/to/project
~/pi-durable-instance/bin/pi-durable --allow-tools
```

Sign in separately on the VPS rather than copying your local OAuth tokens. If you
are already signed into Pi there, the host reuses that login. As of 0.1.0 this
setup has not been deployed to a VPS.

To keep it running after SSH disconnects, use tmux:

```sh
tmux new -s pi-durable
cd /path/to/project
~/pi-durable-instance/bin/pi-durable --allow-tools
# Detach: Ctrl+B, then D
# Reconnect later:
tmux attach -t pi-durable
```

## Credentials and models

- The host uses Pi's `ModelRuntime` with your existing Pi credentials:
  `~/.pi/agent/auth.json`, or `$PI_CODING_AGENT_DIR/auth.json`.
  `--auth-file PATH` selects another Pi-compatible credential file.
- To sign in, run `pi` and use `/login`. Without a separate Pi install, run
  `npm exec -- pi` from the installation directory.
- OAuth refresh uses Pi's credential locking and can update that shared auth file.
  The launcher does not copy tokens into this project or print them.
- API-key providers also accept their usual environment variables, such as
  `OPENAI_API_KEY` for `--model openai/gpt-4o-mini`. Keep secrets out of commands
  that you share or commit.
- Claude through your plan: install Claude Code, sign in with `claude auth login`
  (or `claude`, then `/login`), and launch with `--model claude-cli/sonnet` (or
  `opus`, `haiku`, `fable`). The login stays inside the CLI; the host never reads
  it. `PI_DURABLE_CLAUDE_BIN` selects the `claude` binary (default: `claude` on
  PATH). An `ANTHROPIC_API_KEY` in the environment makes the CLI bill that key
  instead of the plan. On a VPS, sign in to Claude Code there.
- Claude through the API: `ANTHROPIC_API_KEY=sk-ant-api03-…` with
  `--model anthropic/claude-sonnet-5-5`. The host refuses the `anthropic` provider
  when its credential is a Claude subscription token (a Pi "Claude Pro/Max"
  login, `ANTHROPIC_OAUTH_TOKEN`, or an `sk-ant-oat…` token). See
  [models.md](models.md).
- Default model: `openai-codex/gpt-6.1-sol`, thinking `high`.
  `PI_DURABLE_MODEL=PROVIDER/ID` changes the default; `--model PROVIDER/ID` wins over both.
  `--thinking` takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Models must exist in the pinned Pi 1.3.0 catalog, or be one of the `claude-cli`
  aliases. Personal model overrides
  (`models.json`) are deliberately not loaded, and the host fetches no model list.
- The compaction model is chosen from the turn model's provider: `gpt-6-luna` for
  `openai-codex` and `openai`, `haiku` for `claude-cli` (2 calls at a time),
  `claude-haiku-5-5` for `anthropic`, if the catalog has it; otherwise the turn
  model itself. It uses the same credentials, with reasoning `low`. There is no flag for it.
- Before any work launch, the host checks that the model exists and that credentials
  for its provider are available, with a 15 s timeout. `--status` and `--history`
  need no credentials.

## State locations

| Path | What |
|---|---|
| `${XDG_STATE_HOME:-~/.local/state}/pi-durable/` | default data dir |
| `<data dir>/chat.sqlite` | the one chat: Pi, agents, tasks |
| `<data dir>/chat.sqlite-wal`, `chat.sqlite-shm` | SQLite WAL files |
| `<data dir>/chat.sqlite.lock` | the flock file |
| `<data dir>/chat.unii/` | memory: `main/` (log), `tree/` (summaries), `view.json` |

- `--data-dir PATH` or `PI_DURABLE_DATA_DIR` changes the data dir.
- `--database PATH` selects a specific SQLite file. Its memory goes beside it:
  `PATH` with `.sqlite` replaced by `.unii`, or with `.unii` appended if `PATH` does
  not end in `.sqlite`. Its lock is `PATH.lock`.
- Older per-project databases in subfolders of the data dir are left untouched and
  are not imported.
- The CLI and host run with umask 077. New directories are 700 and new files 600.
- `--status` and `--history` on a missing database print `No saved session yet.`
  and create nothing.

## Durability and recovery

- SQLite runs in WAL mode with `synchronous = FULL`, overriding the SDK's `NORMAL`
  default. A committed write survives power loss.
- Memory log lines and tree nodes are fsynced as they are appended; `view.json` is
  replaced atomically.
- Every work launch resumes pending tasks and submissions. Input left queued by a
  failed model request is advanced with an empty `host.resume-boundary` entry.
- Ctrl+C, SIGTERM, and SIGHUP close the Harness and transport without aborting
  durable work. Reopening resumes it.
- Interrupted model requests can be reissued, which costs additional provider usage.
  A failed terminal submission is not retried with a new prompt.
- Agent messages and reports are delivered exactly once across crashes.
- External effects are not exactly-once. An interrupted unsafe tool is reported as
  interrupted, but a shell command may already have changed something. Review such
  changes before asking the model to repeat them.
- This is not a daemon. After exit or a machine shutdown, work stays saved but makes
  no progress until the next launch. No boot service is installed. tmux keeps a host
  running after you disconnect, but not while the machine is off.
- Process recovery does not cover storage or hardware failure, or deletions. Keep backups.

## Backups

1. Stop the host: `/exit` or Ctrl+C. Check with `pi-durable --status`; a running
   host makes it exit with status 75.
2. Copy together: `chat.sqlite`, any `chat.sqlite-wal` and `chat.sqlite-shm`, and
   the whole `chat.unii/` directory.

```sh
cd "${XDG_STATE_HOME:-$HOME/.local/state}/pi-durable"
tar -czf ~/persistence-backup-$(date +%F).tar.gz chat.sqlite* chat.unii
```

Never copy a live SQLite file alone. The archive holds your whole chat; store it privately.
The `.lock` file need not be copied.

## Moving between hosts

1. Stop the host on both machines.
2. Copy the database, its WAL and SHM files, and its `.unii` directory securely,
   for example with `rsync -a` over SSH.
3. On the new host, put them in the default data dir, or launch with
   `--database /path/to/copied.sqlite` (the `.unii` directory must sit beside it with
   the matching name).

The default path depends on `$HOME` and `XDG_STATE_HOME`; an explicit `--database`
avoids those differences. Never let two hosts write the same database. The host is
meant for a local filesystem, not shared or NFS multi-writer storage.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Exit status 75, "already open in another pi-durable process" | Another host holds the lock on this database (perhaps in tmux, or through a symlink alias). Close it first. |
| `pi-durable requires flock` | Install util-linux. |
| `No credentials for PROVIDER` | Run `npm exec -- pi` in the install dir, then `/login`; or set the provider's API-key variable; or pass `--auth-file`. The message names the auth file it read. |
| `No Claude Code login for claude-cli` | Run `claude auth login` (or `claude`, then `/login`). More `claude-cli` symptoms are in [models.md](models.md#troubleshooting). |
| `Refusing anthropic/…: its credential is a Claude subscription` | Use `--model claude-cli/…`, or a Console API key in `ANTHROPIC_API_KEY` after removing any stored Pi `anthropic` login. |
| `Unknown model … in pinned Pi 1.3.0 catalog` | Pick a model from the Pi 1.3.0 catalog. Check `PI_DURABLE_MODEL`. |
| `Node.js >=22.19.0 is required` | Install a newer Node, or set `PI_DURABLE_NODE` to one. |
| An `ExperimentalWarning` about SQLite | Expected on Node 22. Harmless. |
| You want to see what is pending | `pi-durable --status` prints the database, conversation ID, memory dir, scheduler state, and pending tasks and submissions. Each agent keeps one `agents.anchor` task, so the count is not zero while agents exist. |
| Work was interrupted | `pi-durable --resume` finishes it, waits for agents, and prints the history. Add `--allow-tools` if the work needs coding tools. |
| Agents did not finish after `-p` | Agents run only while a host is open. Run `pi-durable --resume`, or open the chat and let them report. |
| `unii: compaction … failed` | The compaction model call failed. The line shows a placeholder and is retried at the next message or after 10 s. `/status` shows `failed` and `lastError`. |
| `unii: log … is not contiguous` | The memory log has a gap. Restore `chat.unii/` from a backup. |
| `--request-id` returns an old answer | That ID was used before. Use a new ID for a new task. |

Exit statuses: 0 success, 1 error, 75 lock busy, 130 SIGINT, 129 SIGHUP, 143 SIGTERM.

## Uninstall

1. Check where `~/.local/bin/pi-durable` points, then remove only that link.
2. Remove the application directory if you want.

This removes neither your state (the data dir) nor your shared Pi credentials.
Delete the data dir yourself, after a backup, if you want the chat gone.
