# Operations

How to install, run, back up, move, and remove a Persistence host.

## Requirements

- Linux, Bash, and `flock` (usually from util-linux).
- bubblewrap (`sudo apt install bubblewrap`), for the coding tools' bash: every command runs in it, so protected
  folders stay protected. Without it bash is off (read, write and edit still work). It needs unprivileged user
  namespaces, the default on Debian and Ubuntu. Without root, put the package's binary in `~/.local/bin`, which
  the host checks before PATH (`PI_DURABLE_BWRAP` names another):

  ```sh
  mkdir -p ~/.local/bin && cd "$(mktemp -d)" && apt-get download bubblewrap \
    && dpkg-deb -x bubblewrap_*.deb x && cp x/usr/bin/bwrap ~/.local/bin/ \
    && ~/.local/bin/bwrap --dev-bind / / -- true && echo ok
  ```
- Chromium, for the `browser` kit's tools (the Reviewer's, ADR 0027): Playwright's build, installed after `npm ci`
  (see the install sections), or `PI_DURABLE_CHROMIUM` set to the absolute path of another Chromium or Chrome
  executable, not a snap one (see [Troubleshooting](#troubleshooting)). Chromium refuses to start its sandbox as
  root, so run the host as an ordinary user (the systemd unit is a user service). Without Chromium only the browser
  tools fail, each call saying why, and a work launch warns which standing agents cannot browse; everything else
  works.
- Node.js 22.19 or newer. The launcher uses `PI_DURABLE_NODE` if set, else `node`
  on PATH. If that `node` is older than 22.19, it falls back to Pi's private Node at
  `~/.local/share/pi-node/current/bin/node` when present.
- No root privileges, Docker, open inbound port, or public web server. Root helps only with system packages:
  bubblewrap, and Chromium's shared libraries if they are missing (the optional `install-deps` step below).

## Autoreview

The default Reviewer's dedicated `autoreview` tool requires the user's canonical skill on **each machine where
reviews execute** (the server for server-target sessions; the workstation for workstation-target sessions):

- `~/.pi/agent/skills/autoreview/SKILL.md` and its `scripts/autoreview` helper. When set,
  `PI_CODING_AGENT_DIR` replaces `~/.pi/agent`.
- Python 3 (`python3`), working bubblewrap, and the skill helper's isolation prerequisites.
- The standalone Codex CLI at `~/.local/share/autoreview/codex-cli/bin/codex`, with working authentication. The tool
  passes this path explicitly, ignoring stale inherited `CODEX_BIN` selections. The Reviewer's own model is
  unchanged; the helper selects its review model according to the installed skill.

The tool always passes `--max-priority P2`, preserves the helper's controls, and executes through `GuardedEnv`.
No skill/CLI is installed or copied automatically. Missing dependencies or protected credentials must be reported;
do not remove protections to make a review pass. Codex is first; `engine: "pi"` is only an explicit availability
fallback after diagnosis and reporting, never a workaround for isolation, safety, rate limits or findings. Pi's
credentials may themselves be protected: that is a blocker, not permission to bypass the guard.

If `settings.json` has a custom `"agents"` roster, include `"autoreview"` in its reviewer's `tools`. The review kit is local: `/tools off` disables it, and SSH execution
requires both server tools and the connector's own per-process grant. It runs through the routed bash operation,
without giving the Reviewer a general shell.

## Install locally

```sh
git clone https://github.com/MatiasGigena/Persistence.git ~/pi-durable-instance
cd ~/pi-durable-instance
npm ci --ignore-scripts
npx --no-install playwright-core install chromium   # the browser tools' Chromium, into ~/.cache/ms-playwright/
npm run check && npm test
mkdir -p ~/.local/bin
ln -s "$HOME/pi-durable-instance/bin/pi-durable" "$HOME/.local/bin/pi-durable"
```

`--no-install` runs the `playwright-core` that `npm ci` installed, so the browser matches the pinned version (a bare
`npx` could fetch the latest one, with a different browser). Run it as the user the host runs as. If Chromium then
fails for missing shared libraries, install them; this optional step needs root and works on Debian and Ubuntu only:

```sh
sudo "$(command -v node)" node_modules/playwright-core/cli.js install-deps chromium
```

If that link already exists, inspect it instead of overwriting it. Make sure
`~/.local/bin` is on PATH, or call `~/pi-durable-instance/bin/pi-durable` directly.
Always launch through `bin/pi-durable` (or `src/cli.ts`), never `src/host/host.ts`:
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
npx --no-install playwright-core install chromium   # the browser tools' Chromium, into ~/.cache/ms-playwright/
npm run check && npm test
mkdir -p ~/.local/bin
ln -s "$HOME/pi-durable-instance/bin/pi-durable" "$HOME/.local/bin/pi-durable"

npm exec -- pi
# In Pi: /login, then exit

cd /path/to/project
~/pi-durable-instance/bin/pi-durable
```

Sign in separately on the VPS rather than copying your local OAuth tokens. If you
are already signed into Pi there, the host reuses that login.

To keep it running after SSH disconnects, use tmux:

```sh
tmux new -s pi-durable
cd /path/to/project
~/pi-durable-instance/bin/pi-durable
# Detach: Ctrl+B, then D
# Reconnect later:
tmux attach -t pi-durable
```

## Remote workstations over SSH

This keeps the chat, models, memory and agents on one server, but runs coding
tools on the workstation where you launched the TUI. It is the native chat
protocol over SSH, not a generic external MCP integration.

### Configure once

1. Install this application on the VPS and workstation. On the VPS, sign into
   the model provider and start [Server mode](#server-mode). The server must
   already be running; the bridge never starts a host for it.
2. Verify the VPS's SSH host-key fingerprint through a trusted channel and
   establish its known-host entry with your normal SSH client. Arrange
   noninteractive authentication (for example an unlocked SSH agent). Test
   `ssh USER@VPS true`; the application uses `BatchMode=yes` and
   `StrictHostKeyChecking=yes`, so it neither prompts for credentials nor trusts
   a new host key. Put custom ports, identities and aliases in `~/.ssh/config`.
3. On the workstation, save the destination, using the remote executable's
   absolute path (replace `USER@VPS` and `USER`):

   ```sh
   pi-durable connect USER@VPS --remote-bin /home/USER/pi-durable-instance/bin/pi-durable
   cd /path/to/project
   pi-durable                         # shared chat, local coding tools OFF
   pi-durable --allow-tools           # explicitly grant this process's tools
   ```

`connect` writes `~/.config/pi-durable/client.json` with a stable `machineId` and
`ssh` preferences (`host`, optional `command` and `dataDir`). It does not connect,
copy credentials, enable tools, or create a local chat. `--remote-data-dir
/absolute/PATH` selects the remote server's nondefault state directory; it and
`--remote-bin` are interpreted literally, without tilde or environment expansion.
The default executable is `pi-durable` on the remote PATH.

The client runs `ssh -T … USER@VPS '…/pi-durable' 'bridge'`, with forwarding
disabled. `bridge` proxies stdin/stdout to the existing, owner-checked mode 600
Unix socket; diagnostics go only to stderr. It opens no database, model runtime,
Harness, flock, TCP listener or SSH forwarding port. The remote login shell must
not print banners to stdout for noninteractive commands. Use the same application
version on both ends (the same `PROTOCOL`). The client also
refuses a server without machine-routing capability before sending a message.

### Launch routing and permission

```sh
pi-durable --remote USER@VPS --remote-bin /home/USER/pi-durable-instance/bin/pi-durable  # once only
pi-durable --cwd /path/to/another/project                               # saved server
pi-durable --local                                                    # old local chat
pi-durable --local --history                                           # inspect local state
```

Selection is `--remote`, then `PI_DURABLE_REMOTE`, then the saved SSH destination.
An explicit or environment host does not inherit the saved host's executable or
data-dir overrides: supply those again when needed. `--local` bypasses all saved
remote preferences, even a damaged configuration. To remove the saved default,
remove only `ssh` from `client.json`, retaining `machineId`; also unset
`PI_DURABLE_REMOTE` if used.

Remote chat requires terminal stdin and stdout. One-shot/positional prompts,
pipes, `--history`, `--status`, `--resume`, `--plain`, `--request-id`, `--model`,
`--thinking`, `--auth-file`, `--database` and `--data-dir` are refused in remote
mode. A bad configuration, missing SSH login, stopped/old server or unsupported
mode fails closed, never falling back to the local chat. Use `/model` for the
server's model and `--remote-data-dir` for its socket location. Admin commands
(`serve`, `backup`, pairing/devices) still operate on the machine where invoked;
run them on the VPS through your normal SSH shell.

- Every remote connector process starts with its own coding/read tools off unless `--allow-tools` is
  passed, even though local launches and `serve` default to guarded coding tools
  on. `/tools on` asks for confirmation and enables both this connector's
  local grant and the server gate; `/tools off` revokes them. Neither permission
  is saved. Another connector being enabled does not authorize this one. A
  server restart restores its launch policy (on unless `--no-tools`), but cannot
  grant a new connector permission.
- Each submitted message pins the exact stable `machineId` and canonical launch
  `cwd`; the footer and dispatch notices identify the destination. New main/sub
  agents inherit their spawner's pin and keep it across model/tools changes and
  restart. A standing agent's newly delegated session inherits the delegating run's
  pin; old sessions and their subs keep theirs. Sending an existing agent a
  message does not move it to your machine.
- While Pi works, a message for the machine and folder its run executes on is
  queued behind the run (Esc withdraws it with the run), and the web app's steer
  reaches the run between its steps (ADR 0042). A message for any other
  destination is refused, naming both: another workstation, or the phone, cannot
  steer an active run onto other files; wait for the run to finish, or stop it,
  and send again. A rejected request ID remains bound to its original destination.
- New agent messages/reports carry their exact source session's destination, so
  Pi can continue and delegate review after a report without changing machines.
  Unmapped legacy reports, mixed-machine inputs and older unpinned sessions cannot
  acquire an implicit server destination; start a new routed task for those cases.
- The connector supports `read`, `write`, `edit` and `bash` (the coding/read kits), plus the `autoreview` kit's
  fixed helper command through the same guarded bash operation.
  `browser_*` and `web_fetch` are unsupported for remote-target sessions: they
  refuse, never silently run on the VPS. In particular, the standing Researcher
  cannot fetch pages for a remote-target task yet. Server-target sessions retain
  their existing network kits and egress rules.
- A cwd pin is routing scope, **not project-only confinement**. The connector's
  `GuardedEnv` hides standard local state and credentials, its client config
  directory and execution ledger, makes system folders read-only, and runs bash
  in bubblewrap (see [Protected folders](#protected-folders)). Outside those
  protections, native tools accept absolute paths and retain the workstation
  user's permissions. There is no per-command approval.

### Disconnects, shutdown and uncertain effects

An offline or disabled connector leaves a call waiting for that exact machine
and cwd. It never runs on the server or another device. A network disconnect
alone does not cancel a command already running on the workstation; reconnecting
resends the same execution ID, which joins live work or returns its cached result.
The current remote CLI's exit path waits for admitted local calls to finish and
be durably cached before closing the link. A bash call with no timeout can delay
exit indefinitely; use explicit stop/cancel when needed, understanding that it is
not rollback. A server shutdown may also send cancellation.

The workstation keeps `machine-tools/` (below), not a local chat. It hashes each
execution ID to a directory, durably writes and fsyncs the intent and payload
fingerprint **before** invoking a tool, and atomically fsyncs its result. Reusing
an ID with changed arguments is refused. A worker crash that leaves an unresolved
intent returns an error with `INDETERMINATE`, never automatically repeats the
side effect. Oversized results are discarded and cached as `RESULT_TOO_LARGE`.

This is duplicate prevention, not transactional exactly-once bash. A command may
have changed files before crashing or being cancelled. A server restart is also
not the same as a link reconnect: native unsafe tool tasks may settle as
interrupted/unknown rather than resume dispatch. Inspect the workstation and its
ledger before requesting a new execution. Retain the ledger; deleting it or
restoring an older copy removes replay protection. It is not part of the server's
chat backup, and may contain private arguments, file contents and results.

## Phone access (SSH/mosh)

This is a shell on the VPS, not a workstation tool connector: tools run on the
VPS. The terminal UI works on a phone at 40 to 60 columns and about 15 rows with the
keyboard open. Below 60 columns it hides the header line, shortens the footer
(the tools state always stays), shows one argument per tool call with a 2-line
preview, removes panel margins and shortens key hints. The spinner slows to 4
frames a second over SSH, since every frame is network traffic.

Run the host in tmux on the server, and add these lines to its `~/.tmux.conf`:

```tmux
set -g default-terminal "tmux-256color"   # the colors and italics the UI uses
set -s escape-time 10                     # Esc interrupts Pi; the 500 ms default feels broken
set -g mouse on                           # scroll the chat with the wheel or a swipe
set -s extended-keys on                   # pass Shift+Enter and other modified keys through
set -as terminal-features 'xterm*:extkeys,xterm*:RGB'  # the outer terminal has them, and true color
set -s focus-events on                    # pass focus changes through to the UI
set -s set-clipboard on                   # copied text reaches the phone's clipboard (OSC 52)
```

Use mosh 1.4 or newer on both ends: it survives network changes and sleep, and
echoes typing locally. Connect over the server's Tailscale IP, so mosh's UDP ports
(60000 to 61000) stay closed to the internet. mosh needs a UTF-8 locale on both
sides:

```sh
LANG=C.UTF-8 mosh --server='LANG=C.UTF-8 mosh-server' user@100.x.y.z -- tmux new -A -s pi-durable
```

- mosh does not pass Shift+Enter through. Use Alt+Enter (or Ctrl+J) for a newline.
- Phone keyboards often lack Esc: `/stop` interrupts Pi, as Esc does.
- Ctrl+D or Ctrl+C twice asks first while Pi or an agent is working; `/exit`
  closes at once. Either way, unfinished work resumes on the next launch.
- Clients: [Blink Shell](https://blink.sh) on iOS has mosh built in; on Android,
  [Termux](https://termux.dev) with `pkg install mosh openssh`.

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
- Model: `--model PROVIDER/ID`, else `PI_DURABLE_MODEL=PROVIDER/ID`, else the model last
  chosen with `/model` in the terminal UI (saved in `settings.json`), else
  `openai-codex/gpt-6.1-sol`. Thinking (reasoning effort): `--thinking`, else the level last chosen with `/effort`
  (also in `settings.json`), else `high`. `--status` shows the model
  and where it came from (`modelSource`). See [models.md](models.md#switching-models).
  `--thinking` takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Models must exist in the pinned Pi 1.5.2 catalog, or be one of the `claude-cli`
  aliases. Personal model overrides
  (`models.json`) are deliberately not loaded, and the host fetches no model list.
- The compaction model is chosen from the turn model's provider: `gpt-6-luna` for
  `openai-codex` and `openai`, `haiku` for `claude-cli` (2 calls at a time),
  `claude-haiku-5-5` for `anthropic`, if the catalog has it; otherwise the turn
  model itself. It uses the same credentials, with reasoning `low`. There is no flag for it.
- Before any work launch, the host checks that the model exists and that credentials
  for its provider are available, with a 15 s timeout. `--status` and `--history`
  need no credentials.

## Protected folders

Coding tools are on by default for local launches and `serve` (ADR 0025); an SSH
connector needs its own explicit grant. Pi and agents with coding/read/autoreview kits use
the same guarded environment on the execution machine. Tools act as your user, except:

| Kind | Paths | The tools |
|---|---|---|
| The chat's state | the data directory; the database, its WAL, lock and socket; `chat.unii/` (with the browser profiles); `settings.json`; `serve/`; `backups/` | cannot read or change |
| Connector state (on a workstation) | client config directory (including `client.json` and `machine-id`), `machine-tools/` ledger | cannot read or change |
| Credentials | Pi's `auth.json`, `~/.ssh`, `~/.gnupg`, `~/.claude`, `~/.claude.json`, `~/.config/gh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` | cannot read or change |
| Your agents | the socket `SSH_AUTH_SOCK` names, `$XDG_RUNTIME_DIR/keyring`, `$XDG_RUNTIME_DIR/gnupg` | cannot reach |
| System | `/etc`, `/usr`, `/boot`, `/opt`, `/bin`, `/sbin`, `/lib*`, `/srv`, `/var/lib` | can read, not change |

read, write and edit refuse such a path with "… is protected"; inside bash, a hidden folder is empty and a hidden
file unreadable, and a system folder is a read-only file system. The model is told about them.

- `PI_DURABLE_SSH_KEYS=~/.ssh/id_ed25519_github` lets Pi `git push` over SSH with those keys only (ADR 0030): the
  launch starts Pi's own `ssh-agent` with them, and bash's `SSH_AUTH_SOCK` names it. Keys need no passphrase (the
  launch warns about one that has). Host keys come from `/etc/ssh/ssh_known_hosts`, since `~/.ssh/known_hosts` is
  hidden: `ssh-keyscan github.com | sudo tee -a /etc/ssh/ssh_known_hosts`, then check the fingerprints against
  GitHub's. On an SSH connector, set it where you run `pi-durable` on the workstation: its tools run there.
- `PI_DURABLE_UNPROTECT=~/.ssh:~/.config/gh` gives paths back, all your keys included.
- `PI_DURABLE_PROTECT=~/secrets:/srv/keys` hides more.

Both take `:`-separated paths, `~` for the home directory; set them in the service's environment file or the
shell, then restart. If bubblewrap is missing or cannot run, the host says so at start ("Coding tools: bash is off")
and bash answers the same way.

## Standing agents' network tools

For server-target sessions, the standing agents (ADR 0027, [agents.md](agents.md))
are held to more than the protected folders. Remote-target network calls are
currently refused; the connector supports coding/read kits and autoreview's fixed helper command.


- `web_fetch` (the Researcher's) refuses loopback, private, link-local, CGNAT (Tailscale) and unique-local addresses,
  on every redirect too.
- The `browser` (the Reviewer's) may open loopback and private addresses, to debug your apps, but always refuses
  link-local ones (cloud metadata such as `169.254.169.254`) and CGNAT (your tailnet). An agent that also reads local
  files, through the `read`, `coding` or `autoreview` kit (the Reviewer, and its subs), gets a local-only browser: loopback and
  private addresses only, so it cannot carry your files to the internet. The policy follows the roster, so a custom
  `agents` entry with `browser` and `read` gets the same.
- An agent without coding tools may message only Pi and its own subs, so it cannot steer one that has them.

## State locations

| Path | What |
|---|---|
| `${XDG_STATE_HOME:-~/.local/state}/pi-durable/` | default local/server chat data dir |
| `${XDG_CONFIG_HOME:-~/.config}/pi-durable/client.json` | workstation identity and default SSH destination; mode 600, no permissions or model credentials |
| `${XDG_CONFIG_HOME:-~/.config}/pi-durable/machine-id` | stable workstation UUID when no saved client config supplies one |
| `${XDG_STATE_HOME:-~/.local/state}/pi-durable/machine-tools/` | workstation execution ledger: hashed call directories, intents and cached results; independent of the chat |
| `<data dir>/chat.sqlite` | the one chat: Pi, agents, tasks |
| `<data dir>/chat.sqlite-wal`, `chat.sqlite-shm` | SQLite WAL files |
| `<data dir>/chat.sqlite.lock` | the flock file |
| `<data dir>/chat.unii/` | memory: `main/` (log), `tree/` (summaries), `view.json` |
| `<data dir>/chat.unii/browser/<agent name>/` | a browser profile (cookies, localStorage) per agent that used the browser tools, shared by all its sessions (a standing agent's tasks); a conversation the agents registry does not name (Pi) uses its conversation ID; mode 700; not backed up; deleted with its agent, a day after archiving (ADR 0034) |
| `<data dir>/settings.json` | the default model and effort chosen with `/model` and `/effort`, and the standing agents: `{"model": "PROVIDER/ID", "thinkingLevel": "high", "agents": {…}}`, each key optional (`agents`: see [agents.md](agents.md)) |
| `<data dir>/chat.sqlite.sock` | `pi-durable serve`'s Unix socket, mode 600, there only while it runs; in `$XDG_RUNTIME_DIR` (as `pi-durable-<hash>.sock`) when the path is over 107 bytes |
| `<data dir>/backups/` | `pi-durable backup`'s backups, one directory each, mode 700; kept 14 days |
| `<data dir>/serve/` | `pi-durable serve`'s state, mode 700: `vapid.json` and `push.json` (see [Push notifications](#push-notifications)), `devices.json`; files mode 600 |

- `PI_DURABLE_CLIENT_CONFIG` overrides the workstation's client config path;
  `machine-id` sits beside it. `XDG_CONFIG_HOME` sets its default root. None of
  these files stores a tools grant. Do not copy one machine's identity to another.
- The workstation ledger uses `XDG_STATE_HOME`, not `--data-dir` or
  `PI_DURABLE_DATA_DIR`; it is separate from the server's chat and backup.
- In local/server mode, `--data-dir PATH` or `PI_DURABLE_DATA_DIR` changes the data dir.
- `--database PATH` selects a specific SQLite file. Its memory goes beside it:
  `PATH` with `.sqlite` replaced by `.unii`, or with `.unii` appended if `PATH` does
  not end in `.sqlite`. Its lock is `PATH.lock`.
- `settings.json` sits beside the database, so with `--database PATH` it is in `PATH`'s
  directory. Only a work launch's `/model` and `/effort` write it, under the database's lock: mode 600,
  written to a temporary file, fsynced and renamed, keeping the keys they do not set (`agents` among them) as
  written. Launches only read it, and
  `--status`, `--history` and `--help` never create it. `/tools` is not saved.
- Older per-project databases in subfolders of the data dir are left untouched and
  are not imported.
- The CLI and host run with umask 077. New directories are 700 and new files 600.
- `--status` and `--history` on a missing database print `No saved chat yet.`
  and create nothing.

## Durability and recovery

- SQLite runs in WAL mode with `synchronous = FULL`, overriding the SDK's `NORMAL`
  default. A committed write survives power loss.
- Memory log lines and tree nodes are fsynced as they are appended; `view.json` is
  replaced atomically.
- Every host work launch resumes pending tasks and submissions. Input left queued by a
  failed model request is advanced with an empty `host.resume-boundary` entry.
  Remote clients do not open or recover a local chat; the central server owns recovery.
- Ctrl+C (twice within a second in the terminal UI; once with `--plain`), Ctrl+D,
  `/exit`, SIGTERM, and SIGHUP close the Harness and transport without aborting
  durable work, and restore the terminal. Reopening resumes it. In the terminal UI,
  Ctrl+D and Ctrl+C twice ask for confirmation while Pi or an agent is working. Esc
  or `/stop` in the terminal UI interrupts Pi's current run only.
- Interrupted model requests can be reissued, which costs additional provider usage.
  A failed terminal submission is not retried with a new prompt.
- Agent messages and reports are delivered exactly once across crashes. This
  guarantee is delivery, not external tool side effects; see
  [Disconnects, shutdown and uncertain effects](#disconnects-shutdown-and-uncertain-effects).
- External effects are not exactly-once. An interrupted unsafe tool is reported as
  interrupted, but a shell command may already have changed something. Review such
  changes before asking the model to repeat them.
- Without `serve`, this is not a daemon. After exit or a machine shutdown, work stays saved but makes
  no progress until the next launch. tmux keeps a host running after you disconnect, but not while the
  machine is off. For a host that runs from boot, see [Server mode](#server-mode).
- Process recovery does not cover storage or hardware failure, or deletions. Keep backups.

## Backups

`pi-durable backup` writes an online backup, with no need to stop anything:

```sh
pi-durable backup                  # into backups/ beside the chat: <data dir>/backups/<UTC time>/
pi-durable backup --out /srv/bak   # into /srv/bak/<UTC time>/
```

- Each backup is a new directory named for the UTC time, like `2026-10-19T03-00-00Z`, holding `chat.sqlite`,
  `chat.unii/` and `settings.json` (when there is one): the whole chat, restorable by copying back.
- Browser profiles (`chat.unii/browser/`) are left out: they hold the sites' login cookies, which should not sit in
  14 days of copies, and Chromium writes them outside the writer's step, so a copy could be torn. After a restore,
  an agent's browser starts with a fresh profile; log in again where needed.
- `chat.sqlite` comes from SQLite's `VACUUM INTO`, a consistent copy. It and the `.unii` copy are made in one
  synchronous step of the one writer, so the memory is never ahead of or behind the database (ADR 0022). Every
  file is fsynced.
- With a server running, the server writes it (`admin.backup` on its socket). Without one, the command takes
  the chat's flock and writes it itself; it exits with 75 while an interactive host has the chat open.
- After each backup, backup directories in the same place older than 14 days are deleted. Nothing else there
  is touched.
- A backup is the whole chat in clear. The directories are mode 700, like the data dir; keep them on the VPS
  or copy them somewhere as private.
- While the copy runs, the server does nothing else: seconds for a large chat, once a day.

On a server, `pi-durable-backup.timer` runs it daily (see [Server mode](#server-mode)):

```sh
systemctl --user list-timers pi-durable-backup.timer    # next and last run
journalctl --user -u pi-durable-backup                  # what each run printed
ls ~/.local/state/pi-durable/backups/
```

To restore one, stop the host, set the current chat aside, and copy the backup into place:

```sh
systemctl --user stop pi-durable        # or close the interactive host
cd "${XDG_STATE_HOME:-$HOME/.local/state}/pi-durable"
mkdir -p replaced && mv chat.sqlite* chat.unii settings.json replaced/
cp -a backups/2026-10-19T03-00-00Z/. .
systemctl --user start pi-durable
```

Never copy a live SQLite file alone; a copy made by hand needs the host stopped and must take `chat.sqlite`, any
`chat.sqlite-wal` and `chat.sqlite-shm`, and `chat.unii/` together.

## Server mode

`pi-durable serve` runs the chat without a terminal, around the clock, as a systemd user service (ADR 0016).
The terminal UI attaches to it over its Unix socket, and the web app reaches it over Tailscale
([Web access over Tailscale](#web-access-over-tailscale)). The unit files are in `contrib/systemd/`.

### Install the service

On the VPS, after [Install on a VPS](#install-on-a-vps) and the logins (`claude auth login`, or Pi's `/login`):

```sh
mkdir -p ~/projects ~/.config/systemd/user ~/.config/pi-durable
cp ~/pi-durable-instance/contrib/systemd/pi-durable.service \
   ~/pi-durable-instance/contrib/systemd/pi-durable-backup.service \
   ~/pi-durable-instance/contrib/systemd/pi-durable-backup.timer ~/.config/systemd/user/
install -m 600 /dev/null ~/.config/pi-durable/env      # then fill it in: below
sudo loginctl enable-linger "$USER"   # user services run from boot, without a login session
systemctl --user daemon-reload
systemctl --user enable --now pi-durable.service pi-durable-backup.timer
systemctl --user status pi-durable
```

- `pi-durable.service` runs `~/pi-durable-instance/bin/pi-durable serve --cwd ~/projects`:
  `~/projects` is the default target for server-local socket/web messages. SSH
  workstations send their own explicit targets instead. Edit `ExecStart` if the
  checkout or directory is elsewhere, then `daemon-reload`.
- Without `enable-linger`, the server stops when you log out and starts only when you log in.
- `systemctl --user stop pi-durable` closes it durably: every client gets "the server is stopping" (and
  reconnects later), and unfinished work resumes at the next start. It exits with 143, which the unit counts
  as a clean stop. On a crash, systemd restarts it after 5 s.

### The environment file

`~/.config/pi-durable/env` holds the server's settings as `NAME=value` lines (mode 600; systemd reads it at each
start, without shell expansion, so write full paths). All are optional:

```sh
# The model; else the last /model choice (settings.json), else openai-codex/gpt-6.1-sol.
PI_DURABLE_MODEL=claude-cli/sonnet
# systemd's PATH may lack ~/.local/bin: add the directories of node and claude if they live there.
PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin
# The web app: both, or neither for socket only (see Web access over Tailscale).
PI_DURABLE_ORIGIN=https://vps.example-tailnet.ts.net
PI_DURABLE_ALLOW_LOGIN=me@github
# PI_DURABLE_PORT=7433             # the loopback port tailscale serve proxies to
# PI_DURABLE_REMOTE_TOOLS=confirm  # off: only a terminal on the VPS may turn coding tools on
# PI_DURABLE_TOOLS_IDLE_MIN=off    # minutes without a run before coding tools turn off; off (default): never
# PI_DURABLE_SSH_KEYS=~/.ssh/id_ed25519_github  # keys for Pi's own SSH agent, bash's only one (':'-separated)
# PI_DURABLE_UNPROTECT=~/.ssh      # let the tools use these protected paths (':'-separated)
# PI_DURABLE_PROTECT=~/secrets     # hide more paths from the tools (':'-separated)
# PI_DURABLE_PUSH_PREVIEW=off      # on: notifications show the reply's first words
# TZ=America/Argentina/Buenos_Aires  # the zone schedules and the times Pi sees are in; default: the system's
# PI_DURABLE_DATA_DIR=/home/me/.local/state/pi-durable
# PI_DURABLE_CHROMIUM=/opt/google/chrome/chrome  # the browser tools' Chromium, not a snap; default: Playwright's, in ~/.cache/ms-playwright
# TZ=America/Argentina/Buenos_Aires  # the host's time zone, so the days /usage counts by; default: the system's
```

A malformed value stops the server at start with a message naming the variable (see the journal).
`systemctl --user restart pi-durable` applies a change.

### What it does

- It starts with the coding tools on, unless `--no-tools`, held to the protected folders (see
  [Protected folders](#protected-folders), ADR 0025). A client switches them: the terminal UI's `/tools`, or the
  web app (turning them on asks first; refused to the web with `PI_DURABLE_REMOTE_TOOLS=off`). They stay on until
  turned off, unless `PI_DURABLE_TOOLS_IDLE_MIN` is set. Every change is shown to every client and written to the
  journal, naming who made it (ADR 0019).
- It listens on the socket `<data dir>/chat.sqlite.sock` (mode 600) as soon as the chat is open, and on
  `127.0.0.1:7433` when the web app is configured; never on another address. It resumes interrupted work behind
  the scenes, so clients can watch it.
- An interactive `pi-durable` in a shell on the VPS, without a saved SSH remote,
  attaches to the running server (its model, tools and directory apply). Remote
  workstations instead use [the SSH connector](#remote-workstations-over-ssh).
  Local one-shot launches (`-p`, `--status`, `--history`, `--resume`) and `--local` need the chat's
  flock, which the server holds: they exit with 75 until it stops.
- `pi-durable serve pair`, `serve devices [--revoke NAME]`, `serve agents` and `backup` talk to it over the socket.
- Once an hour, and at every start, it deletes the agents archived a day or more ago (see
  [Archiving agents](#archiving-agents)).

### Archiving agents

Agents Pi spawned stay in `/agents`, the web app's Agents panel and Pi's `list_agents` until you archive them (ADR
0034). The terminal UI's `/agents` panel and the web app's Agents sheet archive and restore them; so does the server's
CLI:

```sh
pi-durable serve agents                   # every agent: role, parent, busy or idle; archived ones with their deletion time
pi-durable serve agents --archive Helper  # stop Helper (and its sub agents) and archive it
pi-durable serve agents --archive-adhoc   # archive every main agent that is not a standing one
pi-durable serve agents --restore Helper  # bring it back within the day (its stopped work stays stopped)
```

- An archived agent is stopped and hidden, and nothing reaches it: messages to it are refused, and its reports go
  nowhere. `zoom("Helper")` still reads it.
- A day after it was archived it is deleted: its registry record goes, so its name is free again. The server
  checks at every start and then hourly, so an agent of a server that was down is deleted at its next start. Its
  conversation stays in `chat.sqlite`, and `zoom("Helper")` still reads it: the space is not reclaimed.
- The standing agents (Coder, Reviewer, Researcher) cannot be archived; remove one from the roster first.
- Every archive and restore is shown to every client and written to the journal, naming who did it.

### Usage

`/usage` in the terminal UI, and Usage under Chat settings in the web app, show what the chat spent per model: input,
output, cache read and cache written tokens, today, over the last 7 days and all time (ADR 0039). Pi, every agent
and the memory's compactions are counted. A local launch has `/usage` too.

- Costs are the model catalog's prices. On a subscription plan they are not what you pay; read the tokens.
  `claude-cli` models report no cost, so theirs is left out.
- Days are counted from the first launch with this version. What the chat spent before shows in "all time" only, and
  the report's last line says when counting began.
- A day is the host's local day. A server under systemd runs in the system's zone: set `TZ` in the
  [environment file](#the-environment-file) (`TZ=America/Argentina/Buenos_Aires`) to count by your own.
- The host samples the spend every five minutes and for each report, so spend made a few minutes before midnight may
  count for the next day. 62 days are kept.

### Logs

```sh
journalctl --user -u pi-durable -f       # follow
journalctl --user -u pi-durable -b       # since boot
```

The server logs its start (`listening on …`, `ready: …`, whether the web app is on), tool switches
(`coding tools on, by …`, `coding tools off: idle for 30 minutes`), pairings and revocations, `push: …` and
`web: …` lines, host warnings (which clients also see as notices), and `stopping`.

### Updating

```sh
cd ~/pi-durable-instance
git pull --ff-only && npm ci --ignore-scripts && npm run check && npm test
npx --no-install playwright-core install chromium   # after a playwright-core bump: its matching Chromium
systemctl --user restart pi-durable
```

Clients reconnect by themselves; the web app reloads when its files changed. If the unit files in
`contrib/systemd/` changed, copy them again and run `systemctl --user daemon-reload` first.

An update that moves the Pi pins may migrate `chat.sqlite` when it next opens, and an older checkout cannot open a
migrated chat. From Pi 1.3.0 to 1.5.0 the migration is one way (Durable SQLite schema 1 to 2; ADR 0035): run
`pi-durable backup` before the update, and roll back by restoring that backup with the older checkout. From 1.5.0 to
1.5.2 nothing migrates (ADR 0037).

## Web access over Tailscale

`pi-durable serve` serves the web app on `127.0.0.1:7433` (or `--port`, `PI_DURABLE_PORT`) and nowhere else.
`tailscale serve` gives it HTTPS on your tailnet. A browser gets in only with all three of: a tailnet login in
`PI_DURABLE_ALLOW_LOGIN`, the exact origin in `PI_DURABLE_ORIGIN`, and a device paired with a one-time code
(ADR 0019, "Web peers" in [protocol.md](protocol.md#web-peers)). The VPS and the phone must be on the same
tailnet.

1. In the Tailscale admin console, under DNS: enable **MagicDNS**, then **HTTPS Certificates**.
2. On the VPS, proxy tailnet HTTPS to the loopback port (`--bg` keeps it across reboots; without
   `sudo tailscale set --operator=$USER` once, run it with `sudo`):

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:7433
   tailscale serve status   # shows https://<vps>.<tailnet>.ts.net
   ```

3. Find your login: `tailscale whois <the phone's 100.x.y.z address>` prints it (for example
   `alice@example.com` or `alice@github`).
4. Put both in `~/.config/pi-durable/env` (mode 600), then restart the server
   (`systemctl --user restart pi-durable`):

   ```sh
   PI_DURABLE_ORIGIN=https://<vps>.<tailnet>.ts.net
   PI_DURABLE_ALLOW_LOGIN=<login>
   ```

   `PI_DURABLE_ORIGIN` is exactly what the browser's address bar shows: `https://`, the name, no path, no
   trailing slash. Several logins are separated by commas. Without both variables, `serve` runs socket only and
   says so when it starts. A login removed from the list is refused from the next start.

The listener must stay loopback-only. The server trusts the `Tailscale-User-Login` header only because nothing
but `tailscale serve` reaches the port from outside, and only to check it against the allow-list. Never forward
the port, put another proxy in front of it, or use `tailscale funnel` for it.

### Pairing a phone

1. On the VPS: `pi-durable serve pair`. It prints a one-time code, `XXXX-XXXX`, valid for 5 minutes, and the web app's
   address. While the web app is off it refuses and says why.
2. On the phone, open `https://<vps>.<tailnet>.ts.net`. On an iPhone, first add it to the home screen (Share,
   Add to Home Screen) and pair from there: the home-screen app keeps its own cookies, apart from Safari's.
3. Enter the code and a name for the device (1 to 40 characters, unique). Five wrong tries spend the code;
   run `serve pair` again for a new one.

The browser keeps a `pd_device` cookie for 400 days; the server stores only its sha256, in
`<data dir>/serve/devices.json`. A device that clears its site data pairs again.

### Listing and revoking devices

```sh
pi-durable serve devices                  # names, when paired, when last seen (to about 10 minutes)
pi-durable serve devices --revoke phone   # forget it and disconnect it now
```

A wrong name lists the paired ones (names match exactly, case included). A revoked device sees the pairing screen,
saying it was revoked, and needs a new code. For a lost phone, also remove it from the tailnet
in the admin console.

### Certificate names are public

The HTTPS certificate comes from Let's Encrypt, so its name, `<vps>.<tailnet>.ts.net`, is published in the
public Certificate Transparency logs: anyone can learn the machine name and the tailnet name, though not reach
them. Choose a machine name you don't mind, and consider renaming the tailnet's DNS name to a generated one in
the admin console, before enabling HTTPS.

### When it does not connect

- 403: the login is not in `PI_DURABLE_ALLOW_LOGIN`, or `PI_DURABLE_ORIGIN` differs from the address bar.
- The pairing screen keeps coming back: the device is not paired (or was revoked); pair it.
- The server's log (`journalctl --user -u pi-durable`) shows `web: …` lines for pairings and failures.

## Schedules

Pi can leave itself a message for later, once or repeating ("remind me on Friday at 10", "every weekday at 9, tell me
what changed overnight"); see [schedules.md](schedules.md). `/schedule` lists them and `/schedule cancel N` removes
one; the web app lists them under `N scheduled`.

- A schedule fires only while a host runs. Under `pi-durable serve` that is always; a local chat delivers what came
  due while it was closed at its next launch, marked late.
- Times are the host's local time. A VPS is usually on UTC: set your zone in `~/.config/pi-durable/env`
  (`TZ=America/Argentina/Buenos_Aires`) and restart the service. Pi reads the zone from the time in each turn.
- A schedule made from a workstation keeps that workstation for its tools: if the workstation is offline when the
  schedule fires, Pi's run starts and waits at its first coding tool call, and the chat is busy until the
  workstation connects or you stop the run. Schedule from the phone, or in a turn sent without a workstation, for
  work that must run on the server.
- Each wake-up is a model run against your plan or key. At most 32 schedules; a repeating one at most every 5
  minutes.
- Backups hold the schedules: they are tasks and a document in `chat.sqlite`.

## Push notifications

`pi-durable serve` can notify a phone when Pi answers, an agent reports or a schedule fires while no client is visible
(ADR 0021). It needs the web app on its HTTPS origin (`PI_DURABLE_ORIGIN`).

- Android (Chrome, Firefox) and desktop browsers subscribe from the web app. On iPhone and iPad, push works
  only for the app added to the home screen (Share, Add to Home Screen) on iOS or iPadOS 16.4 or newer;
  Safari tabs cannot subscribe.
- By default a notification says only that Pi answered or which agent reported. `PI_DURABLE_PUSH_PREVIEW=on`
  adds the reply's first words, which then show on the lock screen and pass through the push service
  (encrypted, but under its retention).
- The server keeps its VAPID key pair in `<data dir>/serve/vapid.json` and the subscriptions in
  `serve/push.json`, both mode 600. It posts only to the known push services (Google FCM, Apple, Windows,
  Mozilla). A subscription the service reports gone (404 or 410) is dropped, as are a device's subscriptions
  when the device is revoked.
- To reset push, stop the server and delete `serve/vapid.json`. The next start makes new keys and drops every
  subscription, since push services refuse them under another key; each device subscribes again when it next
  opens the app. Deleting only `serve/push.json` forgets the subscriptions and keeps the keys.
- Failures go to the server's log (the systemd journal) as `push: …` lines, with the push service's origin and
  the device name, never the full endpoint.

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

## Checking an install (`pi-durable doctor`)

`pi-durable doctor` checks what this machine needs to run the host, and says what is wrong and how to fix it
(ADR 0041). Run it after an install or an update, on the server and on each workstation, and first when something
does not work.

```
$ pi-durable doctor --local
ok    Node.js: 22.23.1 (needs 22.19 or newer)
ok    flock: on PATH (a local chat and serve lock the chat with it)
ok    bubblewrap: bash runs in its sandbox
skip  SSH keys: PI_DURABLE_SSH_KEYS is not set
ok    settings.json: none at /home/me/.local/state/pi-durable/settings.json; the defaults apply
ok    model openai-codex/gpt-6.1-sol (the default): credentials found
warn  standing agents: Standing agent Reviewer cannot browse: Playwright's Chromium is not installed (…)
      Fix: npx --no-install playwright-core install chromium in /home/me/pi-durable-instance, or set PI_DURABLE_CHROMIUM
ok    autoreview: the skill at /home/me/.pi/agent/skills/autoreview, python3 and the Codex CLI found
ok    chat: /home/me/.local/state/pi-durable/chat.sqlite, 192.0 KiB; no server answers on its socket
ok    memory: 2 day files in /home/me/.local/state/pi-durable/chat.unii/main; view.json parses
warn  backups: no backup in /home/me/.local/state/pi-durable/backups
      Fix: pi-durable backup; for a daily one, the timer in contrib/systemd/ (docs/operations.md, Backups)
skip  remote: --local bypasses a saved remote
skip  server: no systemd user unit and no web settings here
No problems, 2 warnings.
```

- `ok` is fine; `skip` does not apply on this machine, and says why; `warn` is what a launch would only warn about;
  `FAIL` stops a launch or a tool. A `warn` or `FAIL` has a `Fix:` line. The exit status is 1 when a check FAILs.
- It only reads: no lock, no database connection, no model request, nothing created. It is safe while the server
  runs, and before anything is installed.
- On a workstation with a saved remote it skips what the server needs (the model, the standing agents, backups) and
  names the server; run `doctor` on the server for those, or `pi-durable doctor --local` for this machine's own chat.
- `pi-durable doctor --remote-check` also tries the SSH login to the saved server, with the options the chat itself
  uses (no prompt, known host keys only); it is the only check that leaves the machine.
- `pi-durable doctor --json` prints the checks as a JSON array of `{id, level, subject, detail, fix?}`.
- Under systemd the server reads `~/.config/pi-durable/env`; a shell does not, so the `server` check reads that file
  itself, and the others see the shell's environment. A `PATH` set only in that file (for `claude`, say) is not the
  doctor's.

## Troubleshooting

Run [`pi-durable doctor`](#checking-an-install-pi-durable-doctor) first: it finds most of these.

| Symptom | Cause and fix |
|---|---|
| Exit status 75, "already open in another pi-durable process" | Another host holds the lock on this database (perhaps in tmux, or through a symlink alias). Close it first. |
| `pi-durable requires flock` | Install util-linux. |
| "Coding tools: bash is off. bwrap is not installed" | `sudo apt install bubblewrap`, or without root the `~/.local/bin` recipe in [Requirements](#requirements); then restart. |
| "bash is off: bubblewrap cannot run here: … Operation not permitted" | Unprivileged user namespaces are off (`sysctl kernel.unprivileged_userns_clone`, or AppArmor's `kernel.apparmor_restrict_unprivileged_userns` on Ubuntu 24.04). Allow them for bwrap, or run without bash. |
| `git push` says `Host key verification failed` or `Permission denied (publickey)` | Add the host to `/etc/ssh/ssh_known_hosts` and set `PI_DURABLE_SSH_KEYS` ([Protected folders](#protected-folders)). |
| A tool says "… is protected" | The path is a [protected folder](#protected-folders). Set `PI_DURABLE_UNPROTECT` if the tools should use it. |
| `No credentials for PROVIDER` | Run `npm exec -- pi` in the install dir, then `/login`; or set the provider's API-key variable; or pass `--auth-file`. The message names the auth file it read. |
| `No Claude Code login for claude-cli` | Run `claude auth login` (or `claude`, then `/login`). More `claude-cli` symptoms are in [models.md](models.md#troubleshooting). |
| `Refusing anthropic/…: its credential is a Claude subscription` | Use `--model claude-cli/…`, or a Console API key in `ANTHROPIC_API_KEY` after removing any stored Pi `anthropic` login. |
| `Durable SQLite schema version 2 is newer than supported version 1` | A Pi 1.5.0 checkout already migrated this chat, and an older one cannot open it. Update the checkout, or restore a backup taken before the update. |
| `Unknown model … in pinned Pi 1.5.2 catalog` | Pick a model from the Pi 1.5.2 catalog. Check `PI_DURABLE_MODEL` and `settings.json`. |
| A launch fails with "This model was saved by /model in …/settings.json" | The saved default can no longer run. Pass `--model`, sign in again, or remove the `model` key from `settings.json`. Do not delete the file: it may also hold `thinkingLevel` and a custom `agents` roster. |
| `…/settings.json is not valid JSON` | Fix the file; it may hold a custom `agents` roster, so delete it only if it has none. `--model` or `PI_DURABLE_MODEL` skip it meanwhile. |
| "Standing agent … cannot browse: Playwright's Chromium is not installed" | Run `npx --no-install playwright-core install chromium` in the install dir, as the host's user, or set `PI_DURABLE_CHROMIUM`. |
| "Standing agent … cannot run: …", or "could not verify the credentials" | The roster's model for that agent is not in the catalog or its provider has no usable login. Sign in to that provider, or set another `model` for the agent in `settings.json`'s `agents`. Only that agent's tasks fail. |
| A browser tool fails with "No usable sandbox" (Ubuntu 24.04) | AppArmor restricts unprivileged user namespaces, which Chromium's sandbox needs. Add an AppArmor profile for Playwright's Chromium binary (`~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`) that allows `userns`, then `sudo apparmor_parser -r` it; or set `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, which lifts the restriction for every program. Never run the host as root to get around it. |
| A browser tool cannot create its profile, with `PI_DURABLE_CHROMIUM=/usr/bin/chromium` | That is a snap Chromium, which cannot write under dot-directories such as `~/.local/state`. Use Playwright's Chromium (unset the variable) or a non-snap build such as Google Chrome's `/opt/google/chrome/chrome`. |
| "Chromium for the browser tools is not installed" | Run `npx --no-install playwright-core install chromium` in the install dir, as the host's user, or set `PI_DURABLE_CHROMIUM`. |
| "PI_DURABLE_CHROMIUM names …, which does not exist" | Fix the path, or unset the variable to use Playwright's Chromium. |
| "PI_DURABLE_SSH_KEYS: … is not in Pi's SSH agent: it has a passphrase" (or "there is no such file") | Pi's agent cannot ask for a passphrase: use a key without one, or fix the path. |
| "no pi-durable server is running here" (over SSH) | Start the server on that machine (`systemctl --user start pi-durable`), or pass `--remote-data-dir` if it uses another data directory. |
| SSH connect fails with a host-key, `Permission denied` or `command not found` hint | The connector never prompts: run `ssh HOST` once to accept the host key, set up key login, or name the remote binary with `--remote-bin`. |
| `Node.js >=22.19.0 is required` | Install a newer Node, or set `PI_DURABLE_NODE` to one. |
| An `ExperimentalWarning` about SQLite | Expected on Node 22. Harmless. |
| You want to see what is pending | `pi-durable --status` prints the database, conversation ID, memory dir, scheduler state, and pending tasks and submissions. Each agent keeps one `agents.anchor` task, so the count is not zero while agents exist. |
| Work was interrupted | `pi-durable --resume` finishes it, waits for agents, and prints the history. Coding tools are on unless you add `--no-tools`. |
| Agents did not finish after `-p` | Agents run only while a host is open. Run `pi-durable --resume`, or open the chat and let them report. |
| `unii: compaction … failed` | The compaction model call failed. The line shows a placeholder and is retried at the next message or after 10 s. `/status` shows `failed` and `lastError`. |
| `unii: log … is not contiguous` | The memory log has a gap. Restore `chat.unii/` from a backup. |
| `--request-id` returns an old answer | That ID was used before. Use a new ID for a new task. |
| The server keeps restarting | `journalctl --user -u pi-durable -b` shows why: often missing credentials (sign in on the VPS as the same user), a model that cannot run, a malformed `PI_DURABLE_*` value, or `node`/`claude` not on the service's `PATH` (set it in `~/.config/pi-durable/env`). |
| Exit 75 from `serve`, `-p`, `--status` or `--local` while the server runs | The server holds the chat's flock. Use the attached terminal UI, or `systemctl --user stop pi-durable` first. |
| `No server is running for this chat` | `serve pair`, `serve devices` and `serve agents` need the server: `systemctl --user start pi-durable` (or `pi-durable serve`). `backup` works without one. |
| `The socket path … is over 107 bytes and XDG_RUNTIME_DIR is unset` | Use a shorter `--database` or `--data-dir` path, or run under a login session or systemd, which set `XDG_RUNTIME_DIR`. |
| `… exists and is not a socket; move it away` | Something else sits at `<db>.sock`. Move it; the server replaces only a stale socket. |
| `web devices unavailable: …/devices.json is damaged` | The server runs without web pairing. Fix the file, or delete it and pair the devices again. |
| SSH host-key or authentication failure | Verify the host key and configure noninteractive SSH login outside the application; it never auto-trusts a host or falls back to a local chat. |
| `This server lacks machine routing` | Update the server checkout and restart `pi-durable.service`; a matching `PROTOCOL` alone is insufficient; `welcome.machines: true` is also required. |
| Remote flags/mode refused | Use the supported interactive SSH TUI, or `--local` intentionally for local inspection/one-shot modes. |
| Tools wait for a machine | Reconnect that same workstation from the exact launch cwd and explicitly grant tools there; enabling another device cannot reroute it. |
| `INDETERMINATE` | The execution ledger cannot establish whether a side effect finished. Inspect changes; never delete the intent merely to force replay. |
| Exit waits on a local command | The remote CLI drains admitted calls to cache their outcomes; an unbounded bash call can keep it waiting. Stop explicitly if appropriate; cancellation can leave partial effects. |

Exit statuses: 0 success, 1 error, 75 lock busy, 130 SIGINT, 129 SIGHUP, 143 SIGTERM.

## Uninstall

1. Check where `~/.local/bin/pi-durable` points, then remove only that link.
2. Remove the application directory if you want.

This removes neither your state (the data dir) nor your shared Pi credentials.
Delete the data dir yourself, after a backup, if you want the chat gone.
