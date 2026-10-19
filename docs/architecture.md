# Architecture

Persistence is a terminal host around one pi-durable conversation: Pi, the root.
Pi's context is a UniiChat memory view instead of its raw transcript. Pi can spawn
agents, and each agent is another conversation in the same database.

## Components

```
 terminal
    │  argv, stdin
    ▼
 bin/pi-durable ──► src/cli.ts ───► flock --nonblock <db>.lock ──► src/host/host.ts
                    parse args       one host per database          chat loop, /commands,
                    resolve paths    (exit 75 if busy)              reply watcher
                                                                        │
                                                                        ▼
                                                          src/runtime/runtime.ts
                                                          Harness.open (SQLite, synchronous FULL)
                                                                        │
                    ┌───────────────────────────────────────────────────┼──────────────────────┐
                    ▼                                                   ▼                      ▼
             CodingTools                                  uniichat (src/memory)         agents (src/agents)
             read/write/edit/bash                         beforeRequest builds view     spawn_agent, list_agents,
             (enabled only with --allow-tools)            logs every message            send_message, last_message,
                                                          zoom, date                    stop_agent; Deliver tasks
                                                                │
                                                                ▼
                                          chat.unii/  log (main/), tree (tree/), view.json
                                                                ▲
                                                 background compactor (cheap model)
```

- **Launcher** (`bin/pi-durable`): finds a Node.js 22.19 or newer and runs `src/cli.ts`.
  Node strips the types at load: there is no build step ([ADR 0011](decisions/0011-typescript-without-build.md)).
- **CLI** (`src/cli.ts`): sets umask 077, parses arguments, resolves paths, and
  starts the host under `flock`. `--help`, `--version`, and inspection of a missing
  database finish here without a lock.
- **Host** (`src/host/`): creates the model runtime, registers the `claude-cli`
  provider, checks the model and credentials (refusing a subscription token on
  `anthropic`), opens the instance, resumes pending work, then runs the chosen mode:
  `--status`, `--history`, `--resume`, one prompt, piped stdin, or interactive chat.
  Interactive chat in a terminal is the terminal UI; `--plain` (or a stdout that is
  not a terminal) keeps the line-by-line readline chat and its reply watcher.
- **Terminal UI** (`src/ui/tui/`): `app.ts` runs pi-tui in Pi's default full-screen
  (alternate screen) layout: the chat (`chat.ts`) scrolls above a one-line status
  (`footer.ts`) and the editor; `theme.ts` is its palette, and `panels/` holds the
  `/agents` and `/mem` overlays. It knows the host only through `src/ui/types.ts`.
  On exit it prints the chat to the main screen, so it stays in scrollback. While it
  runs, the host's console warnings show as chat notices.
- **Runtime** (`src/runtime/`): opens SQLite and the pi-durable `Harness`,
  installs the three extensions, and configures Pi for this launch.
- **Memory** (`src/memory/`): the UniiChat log, tree, view, and compactor, plus the
  `uniichat` extension that feeds the view to Pi.
- **Agents** (`src/agents/`): the agent registry, the agent tools, and the
  `agents.deliver` tasks that move messages and reports between conversations.
- **Providers** (`src/providers/`): the `claude-cli` model provider, which runs
  each request through the official `claude` CLI and returns its tool calls to
  the Harness, and the `anthropic` subscription check. See [models.md](models.md).

## How a turn flows

1. You type a line. The host submits it to the root:
   `root.submit({ type: 'input', content })`.
2. The Harness commits the input and runs a generation task for the root conversation.
3. Before each model request, the `uniichat` extension's `beforeRequest` hook:
   - records the current system prompt and tools, so compactions share their prefix;
   - waits up to 8 s for pending summaries, then uses placeholders;
   - replaces the request with: system prompt, the view in `<chat>` tags, a
     `<turn>` block with the current date and time, the previous exchange (at most
     16,000 bytes), the run's new message, and the run's own steps;
   - logs the new user message (or agent report) to `chat.unii/main/`.
   The view, turn block, and previous exchange are frozen for the run, so every
   request in one run shares a prefix. Tool results over 30,000 characters are
   clipped in the request.
4. The model answers. `afterResponse` logs Pi's text as `pi` and each tool call as
   `tool`. `afterTool` logs each tool result as `echo`. Every log line has a `src`
   key, so a replay never logs it twice.
5. Tool calls run as tool tasks. Coding tools are present only with `--allow-tools`.
6. The final answer is committed as a `pi.assistant` entry. The host's reply watcher
   subscribes to the root's view and prints each new `pi.assistant` and
   `agents.report` entry, including replies to agent reports that no prompt waited for.
7. Each log append wakes the compactor. In the background it summarizes new
   messages into leaves and merges pairs into parents, at most 8 calls at once, with
   the cheap compaction model. Finished nodes are appended to `chat.unii/tree/`, and
   the view is refit and saved to `view.json`.

pi-durable's own compaction is disabled in the Harness settings, and the extension
declines any root compaction that still starts.

## Agents and the root

- Pi is pi-durable's root conversation (`ROOT_CONVERSATION_ID`).
- `spawn_agent` creates a background `agents.anchor` task in the spawner's
  conversation and a new conversation owned by that task. Pi's interrupt and idle
  waits do not reach it.
- An agent copies Pi's stored agent config: model, thinking level, extensions,
  tools, cwd, and instructions. The host then removes the `uniichat` extension, so
  agents have no memory view and their turns are never logged. Sub agents also lose
  `spawn_agent` and `stop_agent`.
- `syncAgents` re-derives every agent's config on each work launch, right after Pi
  is configured. So `--allow-tools` and `--model` apply to agents too.
- A new agent's first message starts with Pi's current memory view, then
  `[from Spawner] task`.
- Every input to an agent travels in an `agents.deliver` background task. It submits
  with the request ID `agents:<task id>`, waits for the answer, and in one commit
  marks the answer reported and creates the delivery of `[Name] answer` to the parent.
- A report to Pi lands as an `agents.report` input entry. The memory logs it once,
  as a `work` message.
- `zoom("Name")` reads an agent's transcript from SQLite. The registry of agents is
  the `agents.registry` doc in SQLite.

Details: [agents.md](agents.md), [decisions/](decisions/).

## Persistence boundaries

| Store | Holds | Written by | Durability |
|---|---|---|---|
| `chat.sqlite` (with `-wal`, `-shm`) | every conversation (Pi and agents), entries, tasks, submissions, docs such as the agent registry and each conversation's agent config | the Harness | WAL, `synchronous = FULL` |
| `chat.unii/main/YYYY-MM-DD.jsonl` | the memory log: one record `{ i, kind, text, size, date, src? }` per message | `Memory.append` | appended and fsynced per line |
| `chat.unii/tree/YYYY-MM-DD.jsonl` | tree nodes `{ l, i, text }` | the compactor | appended and fsynced per node |
| `chat.unii/view.json` | the chat view and the compaction view | `Memory.save` | written to a temp file, fsynced, renamed |
| `chat.sqlite.lock` | nothing; the flock target | `flock` | none needed |
| Pi's `auth.json` | credentials | Pi's `ModelRuntime` | outside this project |
| `$TMPDIR/pi-durable-claude-*/` | one `claude-cli` request's system prompt and tool list | the provider | removed after the request |

The two stores are not committed together. The memory follows SQLite:

- Log appends are idempotent by `src` (entry ID, message timestamp and hash, tool
  call ID, or report delivery ID). A run replayed after a crash logs nothing twice.
- A log ahead of `view.json` after a crash gets its missing view lines at open.
- A gap in the log refuses to open. An unreadable `view.json` is rebuilt from the log.
- Inspection launches (`--status`, `--history`) do not open the memory directory.

Memory kinds: `user`, `pi`, `tool`, `echo`, `work`, `note`.

## Process model

- One host process per database. The CLI process waits while `flock --no-fork`
  runs the host, and forwards SIGINT, SIGTERM, and SIGHUP to it.
- The lock file is `<database>.lock`, after symlinks are resolved, so an alias of
  the same database is also refused. A second host exits with status 75.
- The memory directory sits beside the database and is covered by the same lock.
  In one process, a second `openMemory` of the same directory throws.
- No daemon, boot service, or inbound listener. Agents and the compactor run inside
  the host. They stop when it exits and continue at the next work launch.
- With `claude-cli`, each model request runs a short-lived `claude -p` child (with
  its stub MCP server), killed when the reply's message ends or the request aborts.
  A crash mid-request leaves no CLI session behind; the Harness reissues the request.
- Shutdown closes the Harness without aborting durable work. The memory gives
  compaction calls in flight up to 5 s, then saves; unfinished calls are redone at
  the next open.

## Module map

| File | Purpose |
|---|---|
| `bin/pi-durable` | Bash launcher: picks Node (`PI_DURABLE_NODE`, `node`, or Pi's private Node) and runs `src/cli.ts` |
| `src/cli.ts` | Entry: parses arguments, checks Node, resolves paths, runs the host under `flock` |
| `src/host/config.ts` | `--help` text, argument parsing, path resolution (data dir, database, `.unii` dir, auth file) |
| `src/host/host.ts` | Model runtime and credential check, modes, terminal chat, /commands, reply watcher, shutdown |
| `src/runtime/runtime.ts` | `openInstance`: SQLite, Harness, extensions, Pi's agent config; `transcript`, `answerText` |
| `src/runtime/recovery.ts` | `resumeInstance` (pending tasks and queued input), `settleAgents` (wait until agents are idle) |
| `src/memory/index.ts` | Public exports of the memory |
| `src/memory/memory.ts` | `Memory`: log, tree, views, compactor scheduling, zoom, date, status; `openMemory` |
| `src/memory/view.ts` | The view: tree lines tiling the log, sawtooth merging, `cut` |
| `src/memory/prompt.ts` | The recipe's system prompt and the leaf and merge compaction tasks |
| `src/memory/summarizer.ts` | Cheap compaction model choice and the pi-ai summarizer |
| `src/memory/extension.ts` | The `uniichat` extension: `beforeRequest` view, logging hooks, `zoom` and `date` tools |
| `src/memory/util.ts` | Sizes, clipping and splitting, line cutting, dates, fsynced appends, atomic writes |
| `src/providers/claude-cli.ts` | The `claude-cli` pi-ai provider: one `claude -p` per request, stream-json to pi-ai events, history folding, auth check |
| `src/providers/claude-cli-mcp.ts` | Stub stdio MCP server that lists Pi's tools to the CLI and runs none |
| `src/providers/anthropic.ts` | `anthropicSubscriptionSource`: detects a Claude subscription credential on the `anthropic` provider |
| `src/agents/index.ts` | The `agents` extension: registry, roles, tools, anchor and deliver tasks; `syncAgents`, `listAgents`, `agentTranscript` |
| `tsconfig.json` | Strict TypeScript for `tsc` (no emit): erasable syntax only, `.ts` import specifiers |
| `eslint.config.ts` | typescript-eslint rules: no `any`, written or inferred, and no suppression comments |
| `test/host/` | CLI parsing, paths, global chat, flock, shutdown |
| `test/runtime/` | Reopen, request IDs, recovery, tool opt-in, synchronous FULL, transcript |
| `test/memory/` | Log, tree, view, compactor, extension |
| `test/agents/` | Roles, messaging, exactly-once delivery across close and SIGKILL |
| `test/providers/` | `claude-cli` against a fake CLI, through the Harness; the stub MCP server; the subscription check |
| `test/fixtures/` | Faux models, the fake `claude` CLI, and child-process instances for the tests |
