# 0027. Standing agents with their own models, tools and a session per task

## Status

Accepted, 2026-10-20, at the user's request. Amends [0003](0003-memory-only-for-pi.md) (agents' tools) and the
"Settings and tools on each launch" rules of [agents.md](../agents.md).

## Context

Every agent Pi spawns is a main agent with a name Pi makes up, and every agent copies Pi's model, thinking level and
tools on each launch (`deriveAgent`). The user wants a fixed team instead: favourite agents, each always on its own
model and effort, with its own tools, that take Pi's work and spawn the throwaway agents themselves. One endless
conversation per standing agent would fill with unrelated old tasks, so each task gets a fresh conversation.

## Decision

### The roster

Three **standing agents**, main agents that always exist:

| Name | Model | Effort | Tool kits |
|---|---|---|---|
| `Coder` | `claude-cli/opus` | `medium` | `coding` |
| `Reviewer` | `openai-codex/gpt-6.1-sol` | `xhigh` | `read`, `browser` |
| `Researcher` | `openai-codex/gpt-6.1-sol` | `high` | `web_fetch` |

This is the built-in roster. `settings.json` may replace it with an `"agents"` object, keyed by name:

```json
{
  "model": "openai-codex/gpt-6.1-sol",
  "thinkingLevel": "high",
  "agents": {
    "Coder": { "model": "claude-cli/opus", "thinkingLevel": "medium", "tools": ["coding"],
               "instructions": "optional text added to its role prompt",
               "subModel": "claude-cli/sonnet", "subThinkingLevel": "medium" }
  }
}
```

`model` and `tools` are required; `thinkingLevel` defaults to `high`; `instructions`, `subModel` and
`subThinkingLevel` are optional. Names follow the agent name rules. An invalid entry is a launch error naming it.
Writing `settings.json` (`/model`, `/effort`) keeps the `agents` key as it is.

Each launch that runs work creates the standing agents that do not exist yet (role `main`, parent `Pi`, registry
field `standing: true`) in one idempotent commit, then re-derives them like every agent. Removing one from the
roster does not delete it: it stays as an ordinary agent, `standing` cleared. Pi may still `spawn_agent` other main
agents as before.

### Tool kits

| Kit | Tools |
|---|---|
| `coding` | `read`, `write`, `edit`, `bash` (through `GuardedEnv`, as Pi's) |
| `read` | `read` |
| `browser` | `browser_goto`, `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`, `browser_screenshot`, `browser_close` |
| `web_fetch` | `web_fetch` |

The agent tools come on top, as for every main agent. `--no-tools` and `/tools off` remove `coding` and `read` from
every standing agent; `browser` and `web_fetch` stay, since they touch no local files.

### Models and effort

`deriveAgent` still copies Pi's choices first, then a standing agent's roster entry overrides model, thinking level,
tools and instructions. `/model` and `/effort` change Pi and its ad-hoc agents only. A sub agent of a standing agent
copies its main agent's model, effort and kits (not Pi's), then `subModel` and `subThinkingLevel` when given; it still
loses `spawn_agent` and `stop_agent`.

### A session per task

Only for standing agents; ad-hoc agents keep one conversation.

- Pi gets a new tool, **`delegate(agent, task)`**: it starts a new task for a standing agent in a **new
  conversation**, whose first input carries Pi's view, as `spawn_agent` does. The registry's `conversationId` is the
  current session; the ones before it are kept, oldest first, in a new field `past`.
- `delegate` refuses while the agent is busy (`Coder is busy with its current task; send_message to steer it, or
  stop_agent first.`). It first stops the previous task's sub agents, so their reports cannot reach the new session.
- **`send_message`** to a standing agent goes to its current session: corrections, questions and steering of the
  task at hand. Pi's prompt says: a new request is `delegate`; a change to, or question about, the work in progress
  is `send_message`.
- `delegate` is replay-safe through `once()`, like `spawn_agent`.
- `zoom("Coder")` reads the current session; `zoom("Coder#2")` reads the second (1 is the oldest). The transcript's
  first line says which session it is and how many there are.
- Continuity between tasks comes from Pi's memory: each new session starts with Pi's view, which holds the earlier
  reports.

### The browser (Reviewer)

Ported from Pi Cloud's `resources/extensions/browser` (at `ff6f72c`) to a pi-durable extension, `src/tools/browser.ts`:
the same eight tools, a headless Chromium with a persistent profile per agent in the chat's state directory (hidden
from the coding tools), one queue serializing operations, a 60 s timeout per operation, HTTP(S) only, sensitive
headers redacted. Always on for agents with the kit: there is no `/browser on`. It may open loopback and private
addresses, since it is for debugging the user's apps. `PI_DURABLE_CHROMIUM` may name the Chromium executable.

### Web fetch (Researcher)

Ported from Pi Cloud's `resources/extensions/web-fetch` to `src/tools/web-fetch.ts`: one tool, `web_fetch(url)`,
returning readable Markdown (Readability, Turndown), PDFs as text, at most 50,000 characters, no third-party reader
services. Unlike Pi Cloud's, it refuses loopback, private, link-local, CGNAT (Tailscale's `100.64.0.0/10`) and
unique-local IPv6 addresses: it resolves the host, checks every address, connects only to a checked one, and does
the same for every redirect (at most 5).

### Persisted names

New and frozen once shipped: the tool names `delegate`, `web_fetch` and the eight `browser_*`; the extension names of
the two new extensions; the registry fields `standing` and `past`, and `session` on a standing agent's sub (the session it belongs to); the `settings.json` key `agents` and its fields.

## Consequences

- A standing agent's work costs its own model's plan: Opus through the Claude CLI, `gpt-6.1-sol` through ChatGPT.
- The browser needs Chromium on the server (`npx playwright-core install chromium`, or `PI_DURABLE_CHROMIUM`).
- A task's context starts clean; anything a new task needs from an old one must be in Pi's view or in the task text.
