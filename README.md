# Persistence

One Pi chat in your terminal that never ends. It runs on the experimental
[`@earendil-works/pi-durable@1.3.0`](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable)
SDK, keeps its memory with Victor Taelin's
[UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
recipe, and lets Pi start agents that work in the background.
`pi-durable` is this project's launcher, with its own terminal UI built on Pi's `pi-tui`.

## Quick start

You need Linux, Bash, `flock` (util-linux), and Node.js 22.19 or newer.
Install bubblewrap for bash (`sudo apt install bubblewrap`); browser tools also need
Chromium (see [requirements](docs/operations.md#requirements)).

```sh
git clone git@github.com:MatiasGigena/Persistence.git ~/pi-durable-instance
cd ~/pi-durable-instance
npm ci --ignore-scripts
npm exec -- pi                 # in Pi: /login, then exit
mkdir -p ~/.local/bin
ln -s "$HOME/pi-durable-instance/bin/pi-durable" "$HOME/.local/bin/pi-durable"
cd /path/to/project && pi-durable
```

If `~/.local/bin/pi-durable` already exists, inspect it before you replace it.
VPS installs, credentials, and backups are in [docs/operations.md](docs/operations.md).

## Usage

There is one chat per host. With a configured remote, every interactive launch
opens the central server's chat; coding tools run on this computer in the launch
directory (or `--cwd`). Without a remote, launches reopen the local chat.
The full-screen UI streams replies above a footer and editor, and leaves the
transcript in scrollback on exit. The following local-mode examples assume no
saved remote; add `--local` to bypass one. `--plain` keeps the local line-based chat.

```sh
pi-durable                                  # interactive chat; coding tools ON, with protected folders
pi-durable --no-tools                       # same, with the coding tools off
pi-durable --plain                          # line-based chat instead of the full-screen UI
pi-durable --print 'Explain this approach'  # one answer, then exit (also: -p, or a positional prompt)
echo 'Summarize this' | pi-durable          # piped stdin is one prompt (max 4 MiB)
pi-durable --history                        # print saved messages; no model request or recovery
pi-durable --status                         # print storage and pending work; no model request or recovery
pi-durable --resume                         # finish interrupted work, wait for agents, print history
pi-durable --request-id my-job-1 --print 'Summarize the design'
pi-durable --model openai/gpt-4o-mini --thinking off
pi-durable --help                           # every flag
```

### One central chat, tools on your computer

Install and run `pi-durable serve` on the server first. Install this checkout on
each workstation too; establish and verify its SSH host key and noninteractive
SSH login before connecting. Then, on the workstation:

```sh
pi-durable connect USER@VPS --remote-bin /home/USER/pi-durable-instance/bin/pi-durable
cd /path/to/project && pi-durable               # central chat; local tools OFF
pi-durable --allow-tools                       # grant tools for this process only
pi-durable --remote USER@OTHER_VPS              # one-launch server override
pi-durable --local                             # explicitly open the old local chat
```

`connect` saves only the machine identity and SSH destination in
`~/.config/pi-durable/client.json`, never a tools grant or model credentials.
SSH carries the native chat protocol through `pi-durable bridge` to the server's
private Unix socket: no extra listening port, generic external MCP server, local
chat database, or local model runtime. Unknown host keys are refused, not trusted
automatically.

Every remote message pins the exact workstation and launch directory; spawned
agents and newly delegated standing-agent sessions inherit that target. Existing
sessions never move. The connector supports coding/read tools and autoreview's fixed helper command; remote-target
`browser_*` and `web_fetch` calls refuse rather than run on the VPS. Offline tools
wait for that same target, never run on the VPS or another computer. A dropped network link does not cancel a running
local command. Exit currently waits for admitted local calls to finish and cache
their results; an unbounded shell command can delay it. Explicit stop/cancel can
leave partial changes. The local ledger prevents automatic replay after an
uncertain worker crash; it does **not** make shell effects transactional.

Remote mode requires a terminal and a server advertising machine routing. It
refuses one-shot prompts, pipes, `--history`, `--status`, `--resume`, `--plain`,
local model/auth/database flags, and unsupported servers; it never silently opens
a local chat instead. Use `/model` on the central chat, or `--local` intentionally.
See [Remote workstations over SSH](docs/operations.md#remote-workstations-over-ssh).
These are installation instructions, not a claim that a VPS has been deployed.

### Attaching on the server

When `pi-durable serve` runs the chat (on a VPS, under systemd: see [docs/operations.md](docs/operations.md)),
a `pi-durable` in a terminal with no configured SSH remote attaches to it over the chat's Unix socket instead of opening the chat itself.
It is the same full-screen chat, but Pi and its agents run in the server, with the server's model, tools and
directory; `/model` and `/tools` change them there. The footer says `reconnecting…` while the server restarts.
For this socket-only TUI, `/exit`, Ctrl+D or Ctrl+C twice detach at once, and Pi keeps working: the terminal prints
`Detached; the server keeps working.`

```sh
pi-durable            # attaches when a server answers; otherwise opens the chat here
pi-durable --attach   # attach, or fail when no server answers
pi-durable --local    # never attach; with a server running this exits 75, as any second launch does
```

Only interactive full-screen chat attaches. In local mode, `-p`, piped stdin, `--status`, `--history`, `--resume` and `--plain`
open the chat locally, so with a server running they exit 75 with
"A server runs this chat; run `pi-durable` to attach." Launch settings (`--no-tools`, `--model`, `--thinking`,
`--cwd`, `--auth-file`) are refused when a server answers, since the server's apply.

`--request-id` deduplicates a one-shot prompt, also after a restart. The same ID
returns its original answer. Use a new ID for a new task, and never reuse an ID
with a different prompt.

Other flags: `--database PATH`, `--data-dir PATH`, `--cwd PATH`, `--auth-file PATH`,
`-v`/`--version`. The default model is `openai-codex/gpt-6.1-sol` with thinking (reasoning effort) `high`.

Chat commands: `/help`, `/model` (pick a model; type to filter, Enter switches),
`/model provider/id` (switch directly), `/effort` (pick the reasoning effort: `low` to `max`,
as the model takes; `/effort xhigh` sets it directly; saved as the default), `/tools` (show), `/tools on` (asks first:
`y` enables read, write, edit and bash for this launch), `/tools off`, `/agents` (list
agents, open any agent's live chat), `/mem` (browse the memory view and zoom down to
any message), `/status`, `/stop` (interrupt Pi, as Esc does; `/stop all` also stops every agent, `/stop Name` one agent and its sub agents), `/exit`. A new model
applies from the next message and becomes the default for launches without `--model`.
Keys: Enter sends, Shift+Enter or Alt+Enter adds a line, Esc interrupts Pi, Ctrl+L
picks a model, Ctrl+O expands tool output, Ctrl+T expands thinking, Ctrl+C twice or
Ctrl+D exits (asking first while Pi or an agent is working). On a phone, see
[Phone access](docs/operations.md#phone-access-sshmosh).
`--plain` mode has `/history` instead of `/agents`, `/mem`, `/model`, `/effort` and `/tools`.
Closing never discards unfinished work; the next launch resumes it.

## Models

The default is `openai-codex/gpt-6.1-sol` with your Pi login. For Claude:

- `--model claude-cli/sonnet` (or `opus`, `haiku`, `fable`) uses your Claude plan through the official
  `claude` CLI. Sign in once with `claude auth login`. Claude only proposes tool calls; the host runs them.
- `--model anthropic/claude-sonnet-5-5` uses an Anthropic Console API key in `ANTHROPIC_API_KEY`. The host
  refuses a Claude subscription login on this provider, as Anthropic's terms require.

Personal use only. Routes, policy, isolation and limits: [docs/models.md](docs/models.md).

## How memory works

- The chat is the memory. Every message, reply, tool call, tool result, and agent report is logged word for word in `chat.unii/main/`.
- In the background, a cheap model (`openai-codex/gpt-6-luna` by default, `claude-cli/haiku` with `claude-cli`) compresses the log into a binary tree of lines of at most 512 bytes (`chat.unii/tree/`).
- Each turn is a fresh model call. It sees a 64–128 KB view of the tree (`chat.unii/view.json`): recent lines are fine, old ones coarse. Then comes the new message.
- Pi opens a vague line with `zoom(id, n)`, down to the original message. `date(id)` gives a message's time.
- Only Pi has this memory, and it declines pi-durable's own compaction. Agents have no view; pi-durable compacts a long agent chat.
- Details and the deviations from the recipe: [docs/memory.md](docs/memory.md).

## How agents work

Pi is the session agent, with a standing team (each configurable in `settings.json`):

| Agent | Model | Effort | Kits |
|---|---|---|---|
| Coder | `claude-cli/opus` | `medium` | coding |
| Reviewer | `openai-codex/gpt-6.1-sol` | `xhigh` | read, browser, autoreview |
| Researcher | `openai-codex/gpt-6.1-sol` | `high` | web_fetch |

`delegate` starts a fresh session for a standing agent's task; `send_message`
steers its current task. Pi can also spawn ad-hoc main agents. Main agents spawn sub agents.
Reviewer must use our installed `/autoreview` skill for every code review, always through **P2** (P0–P2).
Its dedicated tool runs the helper on the pinned machine without granting a general shell or file edits;
`/tools off` disables it. See [setup](docs/operations.md#autoreview) and [workflow](docs/agents.md#reviewer-always-autoreview-through-p2).

```
Pi ─┬─ main agent ─┬─ sub agent
    │              └─ sub agent
    └─ main agent ─── sub agent
```

| Who | list_agents | send_message, last_message | spawn_agent | stop_agent | Pi |
|---|---|---|---|---|---|
| Pi | all | any agent | main agents | any agent | — |
| main agent | all, and Pi | any agent, and Pi | sub agents | its own sub agents | send, last message |
| sub agent | all | any other agent | no | no | no |

Each agent has its own persistent chat and runs in the background. Nobody waits or
polls. When an agent finishes a run, its reply goes to its parent as `[Name] …`:
main to Pi (logged in memory as a `work` message), sub to its main agent.
`zoom("Name")` shows its current chat; `zoom("Coder#2")` reads an earlier session.
Agents without coding kits may message only Pi and their own subs; their subs stay
within that team. Delivery is exactly-once across crashes, not arbitrary shell effects.
Agents work only while a host is open: in chat, their reports print as they arrive;
after `-p`, run `pi-durable --resume` to let them finish. Details: [docs/agents.md](docs/agents.md).

## Safety

Coding tools (read, write, edit, bash) are on for local launches and `pi-durable serve`, unless you pass
`--no-tools`. An SSH workstation connector instead starts with its own tools **off** unless you pass
`--allow-tools` or confirm `/tools on`; remote execution needs both this per-process grant and the server's
coding-tools gate. Neither grant is saved; an enabled server or another connector cannot authorize this one.

When on, tools act with your user permissions except in protected folders: the chat's state and credentials
(`~/.ssh`, `~/.claude`, `~/.config/gh`, `~/.aws`, …) are hidden, and system folders (`/etc`, `/usr`, …) are
read-only. Connectors also hide their client configuration and execution ledger. bash runs in bubblewrap;
without working bubblewrap it refuses. `PI_DURABLE_UNPROTECT=~/.ssh` gives a path back,
`PI_DURABLE_PROTECT` hides more ([ADR 0025](docs/decisions/0025-protected-folders.md)). A machine/cwd pin is
routing scope, not project-only confinement. There is no per-command approval; inspect uncertain shell outcomes
before requesting another execution.

For server-target agents, browser egress checks allow loopback/private apps, refuse link-local and Tailscale/CGNAT
addresses, and refuse public addresses when the agent also has a read/coding/autoreview kit (the default Reviewer).
`web_fetch` accepts public destinations only, on every redirect too. Remote-target network kits are unsupported.
The host does not autoload ordinary Pi extensions, guards, skills, MCP servers, or project instruction files;
Reviewer's dedicated tool is an explicit integration with the installed autoreview skill.

## Project layout

```
bin/pi-durable      launcher: picks Node, runs src/cli.ts
src/cli.ts          arguments, flock, spawns the host
src/host/           terminal chat, /commands, reply watcher; CLI options and paths
src/runtime/        Harness, extensions, Pi's agent config; resume and agent settling
src/memory/         UniiChat memory: log, tree, view, compactor, extension
src/agents/         standing roster, hierarchy, sessions and messaging
src/tools/          browser, web_fetch and autoreview kits
src/machines/       persistent target routing for runs and spawned agents
src/client/         socket/SSH TUI, stdio bridge, local execution ledger
src/protocol/       native chat and machine-execution messages
src/server/         one writer, transports, execution broker, auth, backups, push
src/web/            phone web app and service worker
src/providers/      claude-cli provider (official claude CLI) and the anthropic subscription check
tsconfig.json       strict TypeScript, run by Node's type stripping (no build)
eslint.config.ts    lint rules: no any
test/               offline tests, by area, with fixtures
docs/               architecture, operations, models, memory, agents, decisions, licenses
```

## Docs

- [docs/architecture.md](docs/architecture.md): components, turn flow, persistence, module map
- [docs/operations.md](docs/operations.md): install, credentials, state, backups, troubleshooting
- [docs/models.md](docs/models.md): model routes, the Claude policy, how `claude-cli` works
- [docs/memory.md](docs/memory.md): UniiChat memory and recipe deviations
- [docs/agents.md](docs/agents.md): agent roles, messaging, delivery and execution targets
- [docs/protocol.md](docs/protocol.md): native socket, SSH and web protocol
- [docs/decisions/](docs/decisions/): architecture decision records
- [CONTRIBUTING.md](CONTRIBUTING.md): development, tests, rules
- [AGENTS.md](AGENTS.md): instructions for coding agents
- [CHANGELOG.md](CHANGELOG.md)

## Status

Experimental and personal. It depends on an experimental SDK pinned at 1.3.0.
No license yet; all rights reserved. Parts of `src/memory/` are adapted from
[UniiChat](https://github.com/VictorTaelin/uniichat) under the Apache License 2.0; see [NOTICE](NOTICE).
