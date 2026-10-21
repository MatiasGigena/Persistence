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

## Install locally

```sh
git clone git@github.com:MatiasGigena/Persistence.git ~/pi-durable-instance
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
are already signed into Pi there, the host reuses that login. As of 0.1.0 this
setup has not been deployed to a VPS.

To keep it running after SSH disconnects, use tmux:

```sh
tmux new -s pi-durable
cd /path/to/project
~/pi-durable-instance/bin/pi-durable
# Detach: Ctrl+B, then D
# Reconnect later:
tmux attach -t pi-durable
```

## Phone access (SSH/mosh)

The terminal UI works on a phone at 40 to 60 columns and about 15 rows with the
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

## Protected folders

Coding tools are on by default, for Pi and every agent, local or `serve` (ADR 0025). They act as your user, except:

| Kind | Paths | The tools |
|---|---|---|
| The chat's state | the data directory; the database, its WAL, lock and socket; `chat.unii/` (with the browser profiles); `settings.json`; `serve/`; `backups/` | cannot read or change |
| Credentials | Pi's `auth.json`, `~/.ssh`, `~/.gnupg`, `~/.claude`, `~/.claude.json`, `~/.config/gh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` | cannot read or change |
| System | `/etc`, `/usr`, `/boot`, `/opt`, `/bin`, `/sbin`, `/lib*`, `/srv`, `/var/lib` | can read, not change |

read, write and edit refuse such a path with "… is protected"; inside bash, a hidden folder is empty and a hidden
file unreadable, and a system folder is a read-only file system. The model is told about them.

- `PI_DURABLE_UNPROTECT=~/.ssh:~/.config/gh` gives paths back, for example so Pi can `git push` with your keys.
- `PI_DURABLE_PROTECT=~/secrets:/srv/keys` hides more.

Both take `:`-separated paths, `~` for the home directory; set them in the service's environment file or the
shell, then restart. If bubblewrap is missing or cannot run, the host says so at start ("Coding tools: bash is off")
and bash answers the same way.

## Standing agents' network tools

The standing agents (ADR 0027, [agents.md](agents.md)) are held to more than the protected folders:

- `web_fetch` (the Researcher's) refuses loopback, private, link-local, CGNAT (Tailscale) and unique-local addresses,
  on every redirect too.
- The `browser` (the Reviewer's) may open loopback and private addresses, to debug your apps, but always refuses
  link-local ones (cloud metadata such as `169.254.169.254`) and CGNAT (your tailnet). An agent that also reads local
  files, through the `read` or `coding` kit (the Reviewer, and its subs), gets a local-only browser: loopback and
  private addresses only, so it cannot carry your files to the internet. The policy follows the roster, so a custom
  `agents` entry with `browser` and `read` gets the same.
- An agent without coding tools may message only Pi and its own subs, so it cannot steer one that has them.

## State locations

| Path | What |
|---|---|
| `${XDG_STATE_HOME:-~/.local/state}/pi-durable/` | default data dir |
| `<data dir>/chat.sqlite` | the one chat: Pi, agents, tasks |
| `<data dir>/chat.sqlite-wal`, `chat.sqlite-shm` | SQLite WAL files |
| `<data dir>/chat.sqlite.lock` | the flock file |
| `<data dir>/chat.unii/` | memory: `main/` (log), `tree/` (summaries), `view.json` |
| `<data dir>/chat.unii/browser/<agent name>/` | a browser profile (cookies, localStorage) per agent that used the browser tools, shared by all its sessions (a standing agent's tasks); a conversation the agents registry does not name (Pi) uses its conversation ID; mode 700; not backed up |
| `<data dir>/settings.json` | the default model and effort chosen with `/model` and `/effort`, and the standing agents: `{"model": "PROVIDER/ID", "thinkingLevel": "high", "agents": {…}}`, each key optional (`agents`: see [agents.md](agents.md)) |
| `<data dir>/chat.sqlite.sock` | `pi-durable serve`'s Unix socket, mode 600, there only while it runs; in `$XDG_RUNTIME_DIR` (as `pi-durable-<hash>.sock`) when the path is over 107 bytes |
| `<data dir>/backups/` | `pi-durable backup`'s backups, one directory each, mode 700; kept 14 days |
| `<data dir>/serve/` | `pi-durable serve`'s state, mode 700: `vapid.json` and `push.json` (see [Push notifications](#push-notifications)), `devices.json`; files mode 600 |

- `--data-dir PATH` or `PI_DURABLE_DATA_DIR` changes the data dir.
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
- `--status` and `--history` on a missing database print `No saved session yet.`
  and create nothing.

## Durability and recovery

- SQLite runs in WAL mode with `synchronous = FULL`, overriding the SDK's `NORMAL`
  default. A committed write survives power loss.
- Memory log lines and tree nodes are fsynced as they are appended; `view.json` is
  replaced atomically.
- Every work launch resumes pending tasks and submissions. Input left queued by a
  failed model request is advanced with an empty `host.resume-boundary` entry.
- Ctrl+C (twice within a second in the terminal UI; once with `--plain`), Ctrl+D,
  `/exit`, SIGTERM, and SIGHUP close the Harness and transport without aborting
  durable work, and restore the terminal. Reopening resumes it. In the terminal UI,
  Ctrl+D and Ctrl+C twice ask for confirmation while Pi or an agent is working. Esc
  or `/stop` in the terminal UI interrupts Pi's current run only.
- Interrupted model requests can be reissued, which costs additional provider usage.
  A failed terminal submission is not retried with a new prompt.
- Agent messages and reports are delivered exactly once across crashes.
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

- `pi-durable.service` runs `~/pi-durable-instance/bin/pi-durable serve --cwd ~/projects`: the coding tools work
  in `~/projects`. Edit `ExecStart` if the checkout or the directory is elsewhere, then `daemon-reload`.
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
# PI_DURABLE_UNPROTECT=~/.ssh      # let the tools use these protected paths (':'-separated)
# PI_DURABLE_PROTECT=~/secrets     # hide more paths from the tools (':'-separated)
# PI_DURABLE_PUSH_PREVIEW=off      # on: notifications show the reply's first words
# PI_DURABLE_DATA_DIR=/home/me/.local/state/pi-durable
# PI_DURABLE_CHROMIUM=/opt/google/chrome/chrome  # the browser tools' Chromium, not a snap; default: Playwright's, in ~/.cache/ms-playwright
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
- An interactive `pi-durable` in a shell on the VPS attaches to the running server (its model, tools and
  directory apply). One-shot launches (`-p`, `--status`, `--history`, `--resume`) and `--local` need the chat's
  flock, which the server holds: they exit with 75 until it stops.
- `pi-durable serve pair`, `serve devices [--revoke NAME]` and `backup` talk to it over the socket.

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

1. On the VPS: `pi-durable serve pair`. It prints a one-time code, `XXXX-XXXX`, valid for 5 minutes.
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

A revoked device sees the pairing screen and needs a new code. For a lost phone, also remove it from the tailnet
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

## Push notifications

`pi-durable serve` can notify a phone when Pi answers or an agent reports while no client is visible
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

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Exit status 75, "already open in another pi-durable process" | Another host holds the lock on this database (perhaps in tmux, or through a symlink alias). Close it first. |
| `pi-durable requires flock` | Install util-linux. |
| "Coding tools: bash is off. bwrap is not installed" | `sudo apt install bubblewrap`, or without root the `~/.local/bin` recipe in [Requirements](#requirements); then restart. |
| "bash is off: bubblewrap cannot run here: … Operation not permitted" | Unprivileged user namespaces are off (`sysctl kernel.unprivileged_userns_clone`, or AppArmor's `kernel.apparmor_restrict_unprivileged_userns` on Ubuntu 24.04). Allow them for bwrap, or run without bash. |
| A tool says "… is protected" | The path is a [protected folder](#protected-folders). Set `PI_DURABLE_UNPROTECT` if the tools should use it. |
| `No credentials for PROVIDER` | Run `npm exec -- pi` in the install dir, then `/login`; or set the provider's API-key variable; or pass `--auth-file`. The message names the auth file it read. |
| `No Claude Code login for claude-cli` | Run `claude auth login` (or `claude`, then `/login`). More `claude-cli` symptoms are in [models.md](models.md#troubleshooting). |
| `Refusing anthropic/…: its credential is a Claude subscription` | Use `--model claude-cli/…`, or a Console API key in `ANTHROPIC_API_KEY` after removing any stored Pi `anthropic` login. |
| `Unknown model … in pinned Pi 1.3.0 catalog` | Pick a model from the Pi 1.3.0 catalog. Check `PI_DURABLE_MODEL` and `settings.json`. |
| A launch fails with "This model was saved by /model in …/settings.json" | The saved default can no longer run. Pass `--model`, sign in again, or remove the `model` key from `settings.json`. Do not delete the file: it may also hold `thinkingLevel` and a custom `agents` roster. |
| `…/settings.json is not valid JSON` | Fix the file; it may hold a custom `agents` roster, so delete it only if it has none. `--model` or `PI_DURABLE_MODEL` skip it meanwhile. |
| "Standing agent … cannot browse: Playwright's Chromium is not installed" | Run `npx --no-install playwright-core install chromium` in the install dir, as the host's user, or set `PI_DURABLE_CHROMIUM`. |
| "Standing agent … cannot run: …", or "could not verify the credentials" | The roster's model for that agent is not in the catalog or its provider has no usable login. Sign in to that provider, or set another `model` for the agent in `settings.json`'s `agents`. Only that agent's tasks fail. |
| A browser tool fails with "No usable sandbox" (Ubuntu 24.04) | AppArmor restricts unprivileged user namespaces, which Chromium's sandbox needs. Add an AppArmor profile for Playwright's Chromium binary (`~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`) that allows `userns`, then `sudo apparmor_parser -r` it; or set `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, which lifts the restriction for every program. Never run the host as root to get around it. |
| A browser tool cannot create its profile, with `PI_DURABLE_CHROMIUM=/usr/bin/chromium` | That is a snap Chromium, which cannot write under dot-directories such as `~/.local/state`. Use Playwright's Chromium (unset the variable) or a non-snap build such as Google Chrome's `/opt/google/chrome/chrome`. |
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
| `No server is running for this chat` | `serve pair` and `serve devices` need the server: `systemctl --user start pi-durable` (or `pi-durable serve`). `backup` works without one. |
| `The socket path … is over 107 bytes and XDG_RUNTIME_DIR is unset` | Use a shorter `--database` or `--data-dir` path, or run under a login session or systemd, which set `XDG_RUNTIME_DIR`. |
| `… exists and is not a socket; move it away` | Something else sits at `<db>.sock`. Move it; the server replaces only a stale socket. |
| `web devices unavailable: …/devices.json is damaged` | The server runs without web pairing. Fix the file, or delete it and pair the devices again. |

Exit statuses: 0 success, 1 error, 75 lock busy, 130 SIGINT, 129 SIGHUP, 143 SIGTERM.

## Uninstall

1. Check where `~/.local/bin/pi-durable` points, then remove only that link.
2. Remove the application directory if you want.

This removes neither your state (the data dir) nor your shared Pi credentials.
Delete the data dir yourself, after a backup, if you want the chat gone.
