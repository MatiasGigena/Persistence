# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Coding tools are on by default for `pi-durable serve` too, and no longer turn off after 30 idle minutes
  (`PI_DURABLE_TOOLS_IDLE_MIN=N` brings that back). Instead, for every launch, protected folders: the chat's own
  state and your credentials (`~/.ssh`, `~/.claude`, `~/.config/gh`, `~/.aws`, …) are hidden from the tools, and
  system folders are read-only. read/write/edit check the real path; bash runs in bubblewrap, which is now
  required for bash (`sudo apt install bubblewrap`). `PI_DURABLE_PROTECT` / `PI_DURABLE_UNPROTECT` adjust the list.
  ADR 0025. Protocol 2: `welcome.tools.idleMinutes` is optional; older web pages reload, an older attached TUI asks
  for an update.

- The existing right-hand web menu uses a rounded monochrome glass panel with a
  labelled header, close button and viewport-bounded scrolling; all actions stay the same.

- The web app matches Pi Cloud's dark monochrome palette, monospace type, glass
  surfaces and rounded composer; installed-app and offline colours match too.

- Web app and home-screen icons use Pi Cloud's block mark and Lucide controls.

- Coding tools are on by default for a local launch; `--no-tools` turns them off (`--allow-tools` is kept as a
  no-op). `serve` still starts with them off. ADR 0009 amended.

### Fixed

- Web app: after the phone slept, it could stay on "Reconnecting…" for good: an attempt started around the sleep
  (the `/api/me` check or the WebSocket) could hang without failing, and coming back to the app did nothing while
  one was in flight. Attempts now give up after 10 s; coming back to the front pings a link that looks open
  (dropping it within 5 s if dead) or starts a fresh attempt at once, and the banner waits 2 s before showing.
- `claude-cli`: Opus's thinking streams as a summary (`--thinking-display summarized`); before, it arrived empty,
  so a long think left the chat silent for minutes.
- `claude-cli`: a request whose CLI prints nothing for 10 minutes fails as timed out, and the Harness retries it,
  instead of waiting forever. A turn that only calls tools Pi does not have is an error, not an empty answer.
- The chat shows "The model ended its turn without a reply." when an answer has nothing to show, and says when a
  reply was cut off at the output limit, instead of ending the turn in silence.

### Added

- Web app: a reasoning effort chip beside the model's chip (and "Reasoning effort" in the menu) opens the levels
  the current model takes; tapping one sets it.
- `/effort` picks the reasoning effort (thinking level) for Pi and its agents from the levels the current model
  takes; `/effort LEVEL` sets it directly. It is saved in `settings.json` with the model, and `--thinking`
  overrides it (ADR 0024). `claude-cli` models now list `xhigh` and `max`. Protocol ops `thinking.levels` and
  `thinking.set`.
- The terminal UI footer shows the running tool call next to the spinner while Pi works (for example
  `⠋ working · bash npm test`), so a long turn is never silent. It is cut to 60 columns, or 24 on a phone.

- Server mode (phase 2, ADRs 0016 and 0022 accepted): `pi-durable serve [--cwd D] [--port N]` runs the chat
  headless under its flock, with coding tools off, on a mode 600 Unix socket (NDJSON) and, when configured,
  the web listener. One session is fanned out to every client (`src/server/hub.ts`, `connection.ts`): item
  diffs at most every 50 ms and only while a peer's buffer is under 256 KiB, status at most 4 times a second,
  agent feeds shared by refcount, `bye` 4008 for a peer stuck over 8 MiB for 60 s, 1000 after 60 s of silence,
  and 1012 to everyone on SIGTERM, SIGINT or SIGHUP. Coding tools turned on remotely need a confirmation, are
  refused to the web with `PI_DURABLE_REMOTE_TOOLS=off`, are announced to every client and the journal, and
  turn off after `PI_DURABLE_TOOLS_IDLE_MIN` minutes without a run. Push fires when Pi finishes or an agent
  reports, unless a client was visible in the last minute, at most once per kind per 30 s.
- `pi-durable backup [--out DIR]`: an online backup (`VACUUM INTO`, then `chat.unii/` and `settings.json`, in
  one synchronous step of the writer) into `backups/<UTC time>/` beside the chat; through the server when one
  runs, else under the flock. Backups older than 14 days are deleted. `serve pair` and `serve devices
  [--revoke NAME]` work over the socket.
- `contrib/systemd/`: `pi-durable.service` (`serve --cwd %h/projects`, settings from
  `~/.config/pi-durable/env`) and a daily `pi-durable-backup.timer`. See "Server mode" and "Backups" in
  `docs/operations.md`.
- `UiSession.send` takes an optional `requestId` (pi-durable's submission dedup), which the server passes on.

- The terminal UI attaches to a running server (phase 3, ADR 0018 accepted): an interactive `pi-durable`
  probes the chat's socket and, when `serve` answers, runs the TUI on it with no flock or model runtime of its
  own; `/exit`, Ctrl+D and Ctrl+C twice detach ("Detached; the server keeps working."), the footer shows
  `reconnecting…` while the server restarts, and a message sent across a reconnect arrives once (its
  requestId). `--attach` fails when no server answers; `--local` never attaches. A launch that finds the flock
  busy because a server holds it says "A server runs this chat; run `pi-durable` to attach." New:
  `src/client/` (`attach.ts`, `remote-session.ts`, `unix-link.ts`) and `test/fixtures/fake-server.ts`, an
  in-memory server written from `docs/protocol.md` for client tests.
- The web listener of server mode (phase 4, server half; ADR 0019's access and ADR 0020's server half
  accepted): `src/server/transport-ws.ts` serves HTTP on 127.0.0.1 only, behind `tailscale serve`, with
  `/api/me`, `/api/pair` and the `/ws` WebSocket (`ws` 8.22.0); `src/server/auth.ts` checks the Tailscale login
  allow-list, the Origin and the paired device's `pd_device` cookie (only its sha256 is kept, in
  `serve/devices.json`), and issues one-time pairing codes (5 minutes, 5 tries); `src/server/static.ts` serves
  the web app with TypeScript type-stripped at request time, `marked` 18.0.11 from `node_modules`, ETags, and a
  strict CSP. `ws`, `marked` and `@types/ws` are now pinned directly. See "Web access over Tailscale" in
  `docs/operations.md`.
- Web Push for server mode, on `node:crypto` (phase 6, ADR 0021 accepted): `src/server/push.ts` keeps a VAPID
  key pair in `serve/vapid.json` and the subscriptions in `serve/push.json` (both mode 600), encrypts with
  aes128gcm (RFC 8291, checked against its Appendix A vector), posts only to the known push services, drops a
  subscription on 404 or 410, and retries a 429 or 5xx once. The payload is `{title, body, tag}`; see
  "Push notifications" in `docs/operations.md`.
- The wire protocol for server mode (phase 0 of `docs/plans/server-and-web.md`):
  `src/protocol/` (messages, parser, item diff and mirror, shared by Node and the
  browser) and its spec, `docs/protocol.md`. ADRs 0016 to 0022, proposed.
- The command line of server mode: `serve [--cwd D] [--port N]`, `serve pair`,
  `serve devices [--revoke NAME]`, `backup [--out DIR]`, `--local` and `--attach`,
  and the `PI_DURABLE_ORIGIN`, `PI_DURABLE_ALLOW_LOGIN`, `PI_DURABLE_PORT`,
  `PI_DURABLE_REMOTE_TOOLS`, `PI_DURABLE_TOOLS_IDLE_MIN` and `PI_DURABLE_PUSH_PREVIEW`
  variables are parsed and checked; the commands say which phase implements them.
  `serve` refuses `--allow-tools`.
- The terminal UI's `/mem` loads asynchronously ("Loading…") and reloads while open
  when the memory changes; host warnings reach the chat through the session
  (`onNotice`); an attached TUI detaches on `/exit`, Ctrl+D or Ctrl+C twice and shows
  `reconnecting…` in the footer.
- Terminal UI for interactive chat (pi-tui 1.3.0, full screen like Pi's): the chat
  with streaming Markdown, collapsed thinking and tool output (ctrl+t, ctrl+o),
  agent reports, a status line (model, thinking, tools, work, memory, agents), and
  an editor with history and `/help`, `/agents`, `/mem`, `/status`, `/exit`.
  Esc interrupts Pi; Ctrl+D or Ctrl+C twice exits. `--plain` keeps the line chat.
- `/model` in the terminal UI: a picker (also Ctrl+L, as in Pi) listing every model,
  the current one marked; typing filters, and models without credentials are dim
  and show what they need. `/model provider/id` switches directly, with completion.
  The new model applies from the next message and is saved as the default.
- A phone layout for the terminal UI below 60 columns (SSH or mosh in tmux): no
  header line; a compact footer that drops segments by priority but always shows
  the tools state; tool calls as mark, name and one argument with a 2-line preview;
  no Markdown padding; full-screen panels with short hints, compact rows and the
  selection's detail. The editor stays within about 30% of the rows, and the
  spinner slows to 250 ms over SSH or on a narrow screen. See "Phone access" in
  `docs/operations.md` and ADR 0014.
- `/stop` interrupts Pi, as Esc does, for keyboards without Esc. `/stop all` also stops
  every agent, and `/stop Name` stops one agent and its sub agents (as UniiChat's `/stop`).
- Ctrl+D or Ctrl+C twice asks for confirmation while Pi or an agent is working;
  `/exit` still closes at once.
- `/tools on` and `/tools off` in the terminal UI switch coding tools for this
  launch; turning them on asks for a one-key `y` confirmation. The footer shows
  `tools on` in yellow.
- `claude-cli` provider: `--model claude-cli/opus`, `sonnet`, `haiku` or `fable`
  runs each request through the official `claude` CLI (`claude -p`, stream-json)
  signed in with your own Claude plan. Claude only proposes tool calls, through a
  stub MCP server that runs nothing; the Pi Harness executes them. Each request is
  isolated from your Claude Code settings, hooks, memory and `CLAUDE.md` files.
  `PI_DURABLE_CLAUDE_BIN` selects the binary. See `docs/models.md` and ADR 0010.
- Compaction with `claude-cli` uses `claude-cli/haiku`, at most 2 calls at once;
  with `anthropic`, `anthropic/claude-haiku-5-5`.
- A model switch applies to Pi, every agent and the compaction model from their
  next request, after the same checks as a launch (catalog, credentials, no
  `anthropic` subscription). The model picker lists `claude-cli`, the current
  provider, `openai-codex`, `openai` (with credentials) and `anthropic`, each
  marked available or not with a short note.
- `settings.json` beside the database (mode 600) keeps the model chosen with
  `/model`. A launch takes `--model`, else `PI_DURABLE_MODEL`, else
  `settings.json`, else `openai-codex/gpt-6.1-sol`; `--status` and the `--plain`
  banner show where it came from. See ADR 0013.

### Changed

- A launch whose first word is `serve` or `backup` runs that command; send such a
  prompt with `-p` or after `--`.
- Memory aligned with UniiChat's published source (Apache-2.0, superseding the
  gist; see NOTICE and the rewritten deviations list in `docs/memory.md`). New
  tree nodes only; nodes already built are never rebuilt:
  - The system prompt gains upstream's closing paragraph on compactions ("a
    small, mechanical job … spend few tokens") and no longer promises images
    from `zoom(id, 1)`, since the log keeps text only.
  - A "Too long" retry is a fresh call of the task plus upstream's note on the
    last line, not a second turn carrying the long line.
  - A compaction the model answers without a line (empty, or an Anthropic
    refusal) makes its node the source's first 512 bytes instead of failing and
    retrying forever.
  - A merge's input and an instant merge's text are the halves' flat texts,
    without `id+n|` heads; `flat` now folds the whitespace around a newline, so
    rendered lines of indented text are shorter (one view change at upgrade).
  - Between messages the views change only by a whole batch; at a message a
    batch under way keeps what it merged. The compaction view runs its own
    sawtooth instead of being reset from the chat view.
  - Compactions run in the order the messages came, merges and leaves
    interleaved, instead of leaves first.
  - A `view.json` line whose tree node was lost opens into its halves instead of
    refolding the whole view.
  - Tool output is clipped to at most 30,000 characters including the marker;
    `zoom(id, 1)` pages at 30,000 characters, so a logged message is one page;
    a bad zoom names the tree's roots. A split text's parts are written in one
    fsynced write, and text is made well-formed before it is logged.

- Agents are compacted by pi-durable near their model's context window, so a
  long-lived agent no longer grows past it; Pi still declines pi-durable's
  compaction and keeps its view. See ADR 0015.
- Pi's `<turn>` block lists the agents at work, as upstream UniiChat tells its
  master, and `zoom("Name")` pages an agent's chat at 30,000 characters.
- `zoom("Name")` shows an agent's chat as upstream's numbered `i|kind: text`
  lines: inputs without the view preamble, tool results whole, a note where the
  agent's context was compacted.
- `stop_agent` on a main agent also stops its sub agents. When Pi stops a sub
  agent, the result says its main agent was not told.
- A failed agent run reports its error detail (`[Name] failed: <reason>: <detail>`),
  and an empty final reply reports `[Name] (no reply)` instead of nothing.
- A spawn waits up to 8 s for the view's pending summaries before handing it to
  the new agent, which cannot zoom a placeholder.
- The agents' prompts follow upstream's subagent prompt (Apache-2.0): the view is
  context only and the task decides; the final reply is a self-contained report;
  a main agent does not also send its report to Pi with `send_message`.
  `spawn_agent` asks the spawner to say all the agent needs.
- Agent names start with a letter, since `zoom` reads digits as a message id.
- Every input from an agent to Pi takes upstream's report format,
  `[Name]\ntext\n\nFull chat: zoom("Name")`; inputs to agents stay `[Name] text`.
- `stopAgents()` stops one agent with its sub agents, or every agent, for a
  host-wide stop; `stop_agent` uses it.
- Pi's instructions about the coding tools follow `/tools` and name it, with
  `--allow-tools`, as the only ways to turn them on. ADR 0009 is amended: tools
  can be switched in session but still start off on every launch.
- The `anthropic` provider is refused when its credential is a Claude
  subscription token (a Pi "Claude Pro/Max" login, `ANTHROPIC_OAUTH_TOKEN`, or an
  `sk-ant-oat…` key); it works with an Anthropic Console API key.
- Sources and tests migrated to strict TypeScript (no `any`), checked by tsc and
  eslint; run by Node type stripping with no build step. `npm run check` runs
  tsc, eslint and `bash -n`; `npm run typecheck` and `npm run lint` run each alone.
  See ADR 0011.
- A turn's request (aligned with UniiChat's `Server.ts`, Apache-2.0): the run's
  new message follows `Turn: the user's new message:`, as a compaction's task
  starts with `Compaction:`. The extension takes an optional `atWork()` that lists
  the agents working now in the `<turn>` block, and `zoom("Name", 1, page)` passes
  its page to `resolveAgentChat`.
- The log keeps each tool call right before its result, as UniiChat does, instead
  of all of a reply's calls before their results; a call left without a result is
  logged alone. A reply cut by `/stop` or by a model failure is logged by the next
  run with `[cut off: why]` (aborted replies used to be dropped).
- A run's first input over 128,000 bytes (a huge paste) is no longer sent whole:
  as upstream's `whole`, its first parts are summarized into the view and the
  message carries only its last parts (`Memory.say`). The input is now logged
  before the view is rendered; the view still ends before it.
- Compactions get the turns' system prompt and no tools, as upstream; the
  compaction model usually differs from the turn model, so tools bought no cache.
- `memory.report()` logs a report as Pi sees it, `[Name]\ntext\n\nFull chat:
  zoom("Name")`, instead of `[Name] text`; its `src` key is unchanged.

### Fixed

- A run that failed or was stopped is no longer sent again raw with the next
  message. Before, its messages were carried into every later run until one ended
  with a final answer, so a run that overflowed the context window failed every
  later run too, and after `/stop` the next run reused the stopped run's frozen
  view and date. Now the next run starts at its own message, and the failed run's
  messages are in the view.

## [0.1.0] - 2026-10-19

### Added

- Terminal host for `@earendil-works/pi-durable` 1.3.0, started by the
  `pi-durable` launcher: interactive chat, `--print`, piped stdin, `--history`,
  `--status`, `--resume`, `--request-id`, `--model`, `--thinking`, `--cwd`,
  `--auth-file`, `--database`, `--data-dir`.
- Pi's `ModelRuntime` with the existing Pi credentials; default model
  `openai-codex/gpt-6.1-sol`, thinking `high`; `PI_DURABLE_MODEL`.
- Coding tools (read, write, edit, bash) only with `--allow-tools`, reset on every launch.
- SQLite storage with `synchronous = FULL`, recovery of pending work on reopen,
  and one process per database through `flock` (exit status 75 when busy).
- Private state: umask 077, directories 700, files 600.
- UniiChat memory: a word-for-word log, a background compactor that builds a
  binary tree of lines of at most 512 bytes with a cheap model, a 64–128 KB view
  per turn, and the `zoom` and `date` tools. pi-durable's own compaction is off.
- Agent hierarchy: Pi spawns main agents, main agents spawn sub agents. Tools
  `spawn_agent`, `list_agents`, `send_message`, `last_message`, `stop_agent`.
  Reports reach the parent as `[Name] …`, exactly once across crashes.
- `/help`, `/history`, `/agents`, `/status`, `/exit` chat commands.

### Changed

- **Breaking:** one global chat. Every launch, from any directory, opens
  `chat.sqlite` in the data dir. `--session` is removed. Older per-project
  databases are left untouched and are not imported.
- Source reorganized into `src/host/`, `src/runtime/`, `src/memory/` (was
  `src/unii/`), and `src/agents/` (was `src/agents.mjs`); tests grouped by area
  under `test/`; syntax check moved to `scripts/check.mjs`.

[Unreleased]: https://github.com/MatiasGigena/Persistence/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MatiasGigena/Persistence/releases/tag/v0.1.0
