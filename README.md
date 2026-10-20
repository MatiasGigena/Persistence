# Persistence

One Pi chat in your terminal that never ends. It runs on the experimental
[`@earendil-works/pi-durable@1.3.0`](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable)
SDK, keeps its memory with Victor Taelin's
[UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
recipe, and lets Pi start agents that work in the background.
`pi-durable` is this project's launcher, with its own terminal UI built on Pi's `pi-tui`.

## Quick start

You need Linux, Bash, `flock` (util-linux), and Node.js 22.19 or newer.

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

There is one chat. Every launch, from any directory, reopens it; you cannot create
another. Tools run in the directory you launch from (or `--cwd`). In a terminal it
opens a full-screen chat: replies stream in, with a one-line footer (model, tools,
busy, memory, agents) above the editor. On exit the transcript stays in your
scrollback. `--plain` keeps the simple line-based chat.

```sh
pi-durable                                  # interactive chat; read, write, edit, bash ON with your user permissions
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

### Attaching to a server

When `pi-durable serve` runs the chat (on a VPS, under systemd: see [docs/operations.md](docs/operations.md)),
a plain `pi-durable` in a terminal attaches to it over the chat's Unix socket instead of opening the chat itself.
It is the same full-screen chat, but Pi and its agents run in the server, with the server's model, tools and
directory; `/model` and `/tools` change them there. The footer says `reconnecting…` while the server restarts.
`/exit`, Ctrl+D or Ctrl+C twice detach at once, and Pi keeps working: the terminal prints
`Detached; the server keeps working.`

```sh
pi-durable            # attaches when a server answers; otherwise opens the chat here
pi-durable --attach   # attach, or fail when no server answers
pi-durable --local    # never attach; with a server running this exits 75, as any second launch does
```

Only interactive full-screen chat attaches. `-p`, piped stdin, `--status`, `--history`, `--resume` and `--plain`
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

Pi is the session agent. Ask it for agents and it spawns main agents. Main agents spawn sub agents.

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
`zoom("Name")` shows an agent's whole chat. Delivery is exactly-once across crashes.
Agents work only while a host is open: in chat, their reports print as they arrive;
after `-p`, run `pi-durable --resume` to let them finish. Details: [docs/agents.md](docs/agents.md).

## Safety

Coding tools (read, write, edit, bash) are on for every local launch unless you pass
`--no-tools`; `/tools off` and `/tools on` switch them in the chat, for this launch only.
A server (`pi-durable serve`) still starts with them off. When on, they act with your user permissions. There is no sandbox
and no per-command approval. A tool call saved by an earlier launch cannot restore
permission on a later launch without the flag. The host does not load ordinary Pi
extensions, guards, skills, MCP servers, or project instruction files.

## Project layout

```
bin/pi-durable      launcher: picks Node, runs src/cli.ts
src/cli.ts          arguments, flock, spawns the host
src/host/           terminal chat, /commands, reply watcher; CLI options and paths
src/runtime/        Harness, extensions, Pi's agent config; resume and agent settling
src/memory/         UniiChat memory: log, tree, view, compactor, extension
src/agents/         agent hierarchy and messaging
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
- [docs/agents.md](docs/agents.md): agent roles, messaging, delivery
- [docs/decisions/](docs/decisions/): architecture decision records
- [CONTRIBUTING.md](CONTRIBUTING.md): development, tests, rules
- [AGENTS.md](AGENTS.md): instructions for coding agents
- [CHANGELOG.md](CHANGELOG.md)

## Status

Experimental and personal. It depends on an experimental SDK pinned at 1.3.0.
No license yet; all rights reserved. Parts of `src/memory/` are adapted from
[UniiChat](https://github.com/VictorTaelin/uniichat) under the Apache License 2.0; see [NOTICE](NOTICE).
