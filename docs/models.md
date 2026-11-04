# Models

Which models the host can run, how each one is reached, and the rules that apply to Claude.

## Routes

| `--model` | Reaches | Credential | Billed to |
|---|---|---|---|
| `openai-codex/gpt-6.1-sol` (default) and other `openai-codex/…` | OpenAI through Pi's Codex provider | Pi's `/login` (`auth.json`) | your ChatGPT plan |
| `claude-cli/opus`, `claude-cli/sonnet`, `claude-cli/haiku`, `claude-cli/fable` | Claude through the official `claude` CLI | the CLI's own login (`claude auth login`) | your Claude plan's usage limits |
| `anthropic/claude-sonnet-5-5` and other `anthropic/…` | the Anthropic API through pi-ai | an API key from the Claude Console, in `ANTHROPIC_API_KEY` | your API account |
| any other pi-ai 1.5.0 provider | that provider | its Pi login or API-key variable | that provider |

The `claude-cli` model IDs are the CLI's own aliases, so each follows the CLI to the newest model of its family. With
Claude Code 2.1.303 they resolve to Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1.

```sh
claude auth login                                  # once, in Claude Code itself
pi-durable --model claude-cli/sonnet
ANTHROPIC_API_KEY=sk-ant-api03-… pi-durable --model anthropic/claude-sonnet-5-5
```

## Switching models

In the terminal UI, `/model` switches Pi's model without a relaunch (`src/host/session.ts`, `src/runtime/models.ts`).

- **The list** holds the models worth picking, not the whole catalog: every `claude-cli` model, the current provider's
  models, `openai-codex/…`, `openai/…` only when it has credentials, and `anthropic/…`. Dated snapshots
  (`claude-haiku-4-5-20251001`) are left out beside their aliases. The current model comes first, then the rest
  grouped by provider: the current one's, `claude-cli`, `openai-codex`, `openai`, `anthropic`.
- **Availability.** When the list opens, every listed provider's credentials are checked in parallel with
  `checkAuth`, 5 s each, and reused for 60 s. A model without them is listed but cannot be picked, with a note:

  | Note | Meaning |
  |---|---|
  | `uses your Claude plan via the claude CLI` | `claude-cli`, signed in |
  | `needs claude auth login` | `claude-cli`, not signed in |
  | `needs ANTHROPIC_API_KEY` | `anthropic` without a credential |
  | `subscription login refused; use claude-cli` | `anthropic` with a subscription credential (see Policy) |
  | `needs a Pi login (/login in pi)` | `openai-codex` without a login |
  | `credential check timed out` | the check took over 5 s |

- **Picking one** checks it again, as a launch does: in the catalog, credentials present, no `anthropic`
  subscription. A failure leaves everything as it was and shows the same message a launch would print.
- **What switches.** Pi's stored model (`root.configure({ model })`), then its ad-hoc agents, re-derived from Pi by
  `syncAgents` as on a launch (standing agents keep their own; see [Standing agents](#standing-agents)), then the compaction model: the new provider's cheap one (see
  [memory.md](memory.md#the-model)), so a switch from `openai-codex` to `claude-cli` moves compaction from `gpt-6-luna`
  to `claude-cli/haiku`, 2 calls at once. pi-durable fixes a request's model when it prepares it, so a request already
  under way finishes on the old model; the next one, Pi's or an agent's, uses the new one. Compactions in flight
  finish on the old model too.
- **Saved as the default.** The choice is written to `settings.json` beside the database (mode 600, replaced
  atomically), and later launches use it:

  ```json
  {
    "model": "claude-cli/sonnet"
  }
  ```

  A launch takes `--model`, else `PI_DURABLE_MODEL`, else `settings.json`, else `openai-codex/gpt-6.1-sol`.
  `--status` prints the model and its source (`modelSource`: `flag`, `env`, `settings` or `default`); so does the
  `--plain` banner. Only `/model` and `/effort` write the file. `--plain` chat has neither.

## Reasoning effort

In the web app, the chat settings (the sliders button in the header) hold it as "Thinking", a select of the levels
the current model takes, beside the model's; the header shows both, e.g. `opus · high`. In the terminal UI, the footer
shows it next to the model, and `/effort` opens the same list (`/effort LEVEL` sets one directly). Like a model switch it applies to Pi and its ad-hoc agents from their next request (not to standing agents), and
is saved as `"thinkingLevel"` in `settings.json` ([ADR 0024](decisions/0024-saved-effort.md)). A launch takes
`--thinking`, else the saved level, else `high`.

| Model | Levels |
|---|---|
| `claude-cli/…` | `minimal` (sent as `low`), `low`, `medium`, `high`, `xhigh`, `max` |
| others | what pi-ai declares for the model; `off` only where reasoning can be turned off |

For `claude-cli/opus`, `high` suits most turns; `xhigh` and `max` think longer on hard tasks and use more of the
plan's limits.

`/tools on` and `/tools off` switch the coding tools the same way, for Pi and every agent, but never persist: every
launch starts with them off unless it passes `--allow-tools` ([ADR 0009](decisions/0009-tools-opt-in.md)).

## Standing agents

The standing agents ([ADR 0027](decisions/0027-standing-agents.md), [agents.md](agents.md)) run on their own models
and effort, not Pi's:

| Agent | Model | Effort |
|---|---|---|
| `Coder` | `claude-cli/opus` | `medium` |
| `Reviewer` | `openai-codex/gpt-6.1-sol` | `xhigh` |
| `Researcher` | `openai-codex/gpt-6.1-sol` | `high` |

- `settings.json`'s `"agents"` replaces this roster: each entry's `model` and `thinkingLevel` (default `high`), and
  optionally `subModel` and `subThinkingLevel` for the sub agents it spawns, which otherwise copy their main agent's.
- `/model` and `/effort` (terminal UI or web app) change Pi and its ad-hoc agents only. To move a standing agent to
  another model, edit its entry in `settings.json` and relaunch; `/model` and `/effort` keep the `agents` key as written.
- Each standing agent's work draws on its own model's credentials and limits: the `Coder`'s on your Claude plan
  (through the `claude` CLI, so it needs `claude auth login`), the others' on the Pi login for `openai-codex`. A
  launch requires only Pi's model to run. It also checks each standing agent's model (and `subModel`) against the
  catalog and its provider's credentials, each provider once, in the background (5 s each): a problem is a warning
  naming the agent and the fix (or saying the check could not finish), never a launch failure. A standing agent whose
  model lacks credentials fails its own requests, with the provider's error in its transcript.

## Policy

Anthropic's rules, as of 2026-10-19:

- **A subscription login belongs to Anthropic's own apps.** "OAuth authentication is intended exclusively for
  purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use
  of Claude Code and other native Anthropic applications." Developers "should use API key authentication", and may
  not "route requests through Free, Pro, or Max plan credentials on behalf of their users" or "collect, store, or
  intermediate Claude.ai credentials or session tokens". This "does not … prevent an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription".
  ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))
- **`claude -p` with your plan is allowed and draws on its limits.** "You can still use the Claude Agent SDK,
  claude -p, and third-party apps with your subscription limits" (update of 2026-10-07; the changes announced
  earlier were paused on 2026-06-15). ([Use the Claude Agent SDK with your Claude
  plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))
- **Local experiments are encouraged.** An Anthropic engineer: "We want to encourage local development and
  experimentation with the Agent SDK and claude -p." ([post](https://x.com/trq212/status/2024212380142752025))
- **The CLI's own credentials.** In print mode, `ANTHROPIC_API_KEY` "is always used when present", ahead of the
  subscription login. ([Authentication](https://code.claude.com/docs/en/authentication))

What this host does about it:

- `claude-cli` spawns the unmodified `claude` binary, signed in by you through Anthropic's own flow. The host never
  reads, copies or forwards the CLI's credentials (`~/.claude/.credentials.json`, the keychain), and never calls the
  API with them.
- `anthropic` is accepted only with an API key. pi-ai can also sign that provider in with "Claude Pro/Max" and then
  presents itself as Claude Code. The host refuses to start when the `anthropic` credential is a subscription token:
  - a stored OAuth login in Pi's `auth.json` (`checkAuth` type `oauth`);
  - `ANTHROPIC_OAUTH_TOKEN`;
  - any key or `ANTHROPIC_AUTH_TOKEN` bearer starting `sk-ant-oat` (subscription tokens, including those made by
    `claude setup-token`; Console keys start `sk-ant-api`).

  The check reads the stored type and env source first, so it never refreshes an OAuth login
  (`src/providers/anthropic.ts`). A gateway's own bearer token passes.
- `--bare` is not used: it ignores the subscription login.

## How claude-cli works

`src/providers/claude-cli.ts` is a pi-ai provider (`createProvider`), registered on the host's models on every
launch, inspection included, because persisted agents can name `claude-cli` models. Each model request is one fresh
CLI process:

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --no-session-persistence
       --tools '' --strict-mcp-config [--mcp-config '{"mcpServers":{"pi":…}}'] --disable-slash-commands
       --setting-sources '' --settings '{"autoMemoryEnabled":false,"disableAllHooks":true}'
       --model haiku --max-turns 1 --system-prompt-file <dir>/system.md --thinking-display summarized
       [--effort high]
       < one stream-json user message on stdin (--input-format stream-json)
```

- **Claude only proposes tool calls.** Built-in tools are off (`--tools ''`). Pi's current tools are listed by a stub
  stdio MCP server named `pi` (`src/providers/claude-cli-mcp.ts`), so Claude sees them natively as
  `mcp__pi__<name>`. The stub never runs anything; a call that reaches it gets "deferred to host". In print mode the
  CLI also denies unapproved MCP tools before they run.
- **The provider stops the CLI at `message_stop`.** Each `tool_use` named `mcp__pi__…` becomes a Pi `toolCall` (its
  id, the name without the prefix, the input). Any `tool_use` makes the stop reason `toolUse`. The CLI is killed so it
  neither handles the call nor continues; `--max-turns 1` is the backstop (verified: one API request, then
  `error_max_turns`). The Pi Harness then runs the calls as durable tool tasks.
- **Every request is built fresh from the context.** UniiChat rewrites the messages of every request, so no CLI session
  is reused: no `--resume`, no `--session-id`, and pi-ai's `sessionId` is ignored. The system prompt is Pi's current
  one (`getCurrentSystemPrompt`) plus a short note on the transcript convention. Earlier messages are folded into one
  user prompt:

  ```
  <transcript>
  <user>…</user>
  <assistant>…</assistant>
  <tool_call id="toolu_…" name="read">{"path":"a.txt"}</tool_call>
  <tool_result id="toolu_…" name="read" is_error="false">…</tool_result>
  </transcript>

  <the latest user message, or "Continue from the last tool result.">
  ```

  A lone user message, the usual first request of a run, is sent unchanged. Thinking is not replayed. This text goes
  on stdin as one stream-json user message (`--input-format stream-json`, `renderInput`); the latest user message's
  images go before it in the same message as base64 image blocks, so the models declare text and image input (ADR
  0031). Images in earlier turns become `[image: <type>, not shown]` in the transcript.
- **Effort.** pi-ai's reasoning level becomes `--effort`: minimal and low → `low`, then `medium`, `high`, `xhigh`,
  `max`. Thinking cannot be turned off; without a level the CLI uses its default.
- **Thinking display.** Opus omits its thinking from the stream by default: the blocks arrive empty, so a long
  think shows nothing at all. `--thinking-display summarized` streams a summary instead, shown (collapsed, Ctrl+T)
  while Claude thinks. It is still not replayed.
- **Compaction.** The compactor sends `toolChoice: "none"`; such a request gets no MCP server at all. Its
  `maxTokens` is not passed (the CLI sets its own); the compactor's 512-byte cut bounds the result anyway.
- **Usage.** Input, output, cache read and cache write tokens come from the stream's `message_start` and
  `message_delta`. Cost is left at zero: on a plan nothing is billed per token, and the CLI's `total_cost_usd` is a
  list-price estimate.
- **Errors.** A `result` with `is_error` (`claude-cli: API error 529: …`), a non-zero exit without a reply, a missing
  binary, `timeoutMs`, and a `401` retry (not signed in) end the stream with an error. A `rate_limit_event` whose status
  is `rejected` ends it with "Claude usage limit reached (five_hour quota exceeded) · resets …"; the words "quota
  exceeded" keep pi-ai from retrying a limit that lasts hours. Overload and timeout texts stay retryable. The CLI also
  retries API errors itself (up to 10 times, with backoff) before it reports one.
- **Stalls.** A CLI that prints nothing for 10 minutes is killed, and the request ends with "no output from claude
  for 600 s (timed out)", which the Harness retries. Every stream line counts, the CLI's own `api_retry` lines
  included, so a CLI that is retrying an overloaded API is not cut off.
- **Calls to tools Pi does not have.** Claude sometimes calls one of Pi's tools by its bare name (`spawn_agent`, as
  the transcript writes it) instead of `mcp__pi__spawn_agent`; such a call is still Pi's. A turn whose only
  `tool_use` names a tool Pi does not offer ends with an error naming it, instead of an empty answer.
- **Abort.** The request's signal kills the CLI and ends the stream as `aborted`.
- **Auth check.** `claude auth status --json` (10 s timeout, no prompt) must report `loggedIn`; requests carry no
  auth of the host's own.

### Isolation

Each request runs in a new private directory under the system temp dir (`$TMPDIR`), removed afterwards, which holds
only the system prompt and the tool list. Checked on 2.1.303, against a local mock API and with three live calls:

| Source | Reaches the request? |
|---|---|
| `CLAUDE.md` in parent directories (project memory) | no (`--setting-sources ''`) |
| `~/.claude/CLAUDE.md` (user memory) | no (`--setting-sources ''`) |
| `AGENTS.md` | no |
| user and project `settings.json`, their hooks and enabled plugins | no (`--setting-sources ''`, `disableAllHooks`) |
| auto memory (`MEMORY.md` for the directory) | no (`autoMemoryEnabled: false`; `--setting-sources ''` alone leaves it on) |
| MCP servers from your config, claude.ai connectors, skills, slash commands | no (`--strict-mcp-config`, `--disable-slash-commands`) |
| session transcripts in `~/.claude/projects` | none written (`--no-session-persistence`) |

What still reaches the model:

- a fixed preamble before Pi's system prompt: "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
- an environment block after the prompt: the private directory, platform, shell, OS version, model name and date;
- managed (policy) and server-managed settings, which the CLI always applies;
- the CLI's built-in plugins and subagent definitions, which are inert without tools.

Variables that mark a parent Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) are removed from the
child's environment. Everything else passes through as you set it. In particular, an `ANTHROPIC_API_KEY` in the
host's environment makes the CLI bill that key instead of your plan.

## Limits

- **Plan usage limits.** Every request is a full CLI call that draws on your plan's limits, and so does every
  compaction. With `claude-cli`, the compactor uses `claude-cli/haiku` and runs at most 2 calls at once instead of 8.
  Agents spawned by Pi use the same model and limits.
- **Overhead.** Each request starts a process and the stub MCP server, about 0.5 s before the request is sent. Prompt
  caching covers the system prompt and tools, and part of the prompt when it grows between calls.
- **Open question.** Anthropic's April 2026 change concerns subscription use in third-party harnesses. Whether a
  wrapper that runs the unmodified CLI counts as one has no official answer. This route rests on the statements
  quoted above; recheck them before you depend on it.
- **Personal use only.** The route is for you, on your own login. Anything you distribute, host or run for other
  people must use API keys (`anthropic/…`), as the legal page requires.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No Claude Code login for claude-cli` | Run `claude`, then `/login`, or `claude auth login`. Check with `claude auth status`. |
| `claude-cli: claude not found` | Install Claude Code, or point `PI_DURABLE_CLAUDE_BIN` at the binary. |
| `Unknown model claude-cli/…` | Use `opus`, `sonnet`, `haiku` or `fable`. |
| `Claude usage limit reached … resets …` | The plan's limit is used up. Wait for the reset; the turn is not retried. |
| `claude-cli: … not signed in or its login expired (401)` | Sign in again with `claude auth login`. |
| Requests bill your API account | `ANTHROPIC_API_KEY` is set in the host's environment. Unset it to use the plan. |
| `No credentials for anthropic. Set ANTHROPIC_API_KEY …` | Export a Console API key (`sk-ant-api…`), or use `--model claude-cli/…`. Pi's `/login` for anthropic is the Pro/Max login, which is refused. |
| `Refusing anthropic/…: its credential is a Claude subscription` | Use `--model claude-cli/…`, or a Console API key. A stored Pi `anthropic` login wins over the variable: remove it with Pi's `/logout`. |
| A launch fails with "This model was saved by /model in …/settings.json" | The saved default can no longer run (signed out, for example). Pass `--model`, sign in again, or remove the `model` key from `settings.json`. Do not delete the file: it may also hold `thinkingLevel` and a custom `agents` roster. |
| `…/settings.json is not valid JSON` or `must be an object like {"model":…}` | Fix the file; it may hold a custom `agents` roster, so delete it only if it has none. `--model` still works meanwhile. |
| `claude-cli: API error 529: …` | Anthropic is overloaded; the Harness retries. |
| `claude-cli: no output from claude for 600 s (timed out)` | The CLI stalled; the Harness retries. If it keeps happening, check the network and `claude` itself. |
| "The model ended its turn without a reply." | The model answered with nothing to show (only thinking, for example). Ask it to continue or to report. |
| `claude-cli: … error: unknown option '--thinking-display'` | Claude Code is too old; update it (`claude update`). |

See [ADR 0010](decisions/0010-claude-via-cli.md) for the decision.
