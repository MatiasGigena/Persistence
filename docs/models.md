# Models

Which models the host can run, how each one is reached, and the rules that apply to Claude.

## Routes

| `--model` | Reaches | Credential | Billed to |
|---|---|---|---|
| `openai-codex/gpt-6.1-sol` (default) and other `openai-codex/…` | OpenAI through Pi's Codex provider | Pi's `/login` (`auth.json`) | your ChatGPT plan |
| `claude-cli/opus`, `claude-cli/sonnet`, `claude-cli/haiku`, `claude-cli/fable` | Claude through the official `claude` CLI | the CLI's own login (`claude auth login`) | your Claude plan's usage limits |
| `anthropic/claude-sonnet-5-5` and other `anthropic/…` | the Anthropic API through pi-ai | an API key from the Claude Console, in `ANTHROPIC_API_KEY` | your API account |
| any other pi-ai 1.3.0 provider | that provider | its Pi login or API-key variable | that provider |

The `claude-cli` model IDs are the CLI's own aliases, so each follows the CLI to the newest model of its family. With
Claude Code 2.1.303 they resolve to Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1.

```sh
claude auth login                                  # once, in Claude Code itself
pi-durable --model claude-cli/sonnet
ANTHROPIC_API_KEY=sk-ant-api03-… pi-durable --model anthropic/claude-sonnet-5-5
```

## Switching models

In the terminal UI, `/model` switches Pi's model without a relaunch (`src/ui/session.ts`, `src/runtime/models.ts`).

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
- **What switches.** Pi's stored model (`root.configure({ model })`), then every agent, re-derived from Pi by
  `syncAgents` as on a launch, then the compaction model: the new provider's cheap one (see
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
  `--plain` banner. Only `/model` writes the file; the thinking level is not saved. `--plain` chat has no `/model`.

`/tools on` and `/tools off` switch the coding tools the same way, for Pi and every agent, but never persist: every
launch starts with them off unless it passes `--allow-tools` ([ADR 0009](decisions/0009-tools-opt-in.md)).

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
claude -p --output-format stream-json --verbose --include-partial-messages --no-session-persistence
       --tools '' --strict-mcp-config [--mcp-config '{"mcpServers":{"pi":…}}'] --disable-slash-commands
       --setting-sources '' --settings '{"autoMemoryEnabled":false,"disableAllHooks":true}'
       --model haiku --max-turns 1 --system-prompt-file <dir>/system.md [--effort high]
       < prompt on stdin
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

  A lone user message, the usual first request of a run, is sent unchanged. Thinking is not replayed. Images become
  `[image: <type>, not shown]`; the models declare text input only.
- **Effort.** pi-ai's reasoning level becomes `--effort`: minimal and low → `low`, then `medium`, `high`, `xhigh`,
  `max`. Thinking cannot be turned off; without a level the CLI uses its default.
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
| `Refusing anthropic/…: its credential is a Claude subscription` | Use `--model claude-cli/…`, or a Console API key. A stored Pi `anthropic` login wins over the variable: remove it with Pi's `/logout`. |
| A launch fails with "This model was saved by /model in …/settings.json" | The saved default can no longer run (signed out, for example). Pass `--model`, sign in again, or delete the file. |
| `…/settings.json is not valid JSON` or `must be an object like {"model":…}` | Fix the file or delete it; `--model` still works meanwhile. |
| `claude-cli: API error 529: …` | Anthropic is overloaded; the Harness retries. |

See [ADR 0010](decisions/0010-claude-via-cli.md) for the decision.
