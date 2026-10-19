# 0010. Claude through the official CLI, which only proposes tool calls

## Status

Accepted, 2026-10-19

## Context

The user wants Claude models with a Claude subscription. pi-ai 1.3.0's `anthropic` provider can sign in with "Claude
Pro/Max" and then presents itself as Claude Code to the API. Anthropic permits subscription OAuth only for Claude Code
and its other native apps, and forbids third parties from routing requests through those credentials. It does allow
signing in to the unmodified Claude Code binary, and it encourages local experiments with `claude -p`, which draws on
the plan's limits ([docs/models.md](../models.md#policy)).

Pi's turns must stay durable: the Harness runs every tool call as a task, and UniiChat rewrites the context of every
request. The CLI, by contrast, is an agent loop with its own tools, sessions and settings.

## Decision

- Add a `claude-cli` pi-ai provider (`src/providers/claude-cli.mjs`) with the CLI's aliases `opus`, `sonnet`, `haiku`
  and `fable`. Each request spawns the unmodified `claude -p` once, in stream-json mode, with no session persistence.
- Claude only proposes tool calls. Built-in tools are off; Pi's tools are listed by a stub MCP server that runs
  nothing. The provider maps `tool_use` blocks to Pi tool calls and kills the CLI at the end of the message, with
  `--max-turns 1` as the backstop. The Harness executes the calls.
- Each request is built from the context alone: Pi's system prompt, and earlier messages folded into one tagged user
  prompt. No `--resume`.
- Isolate the CLI: a private empty working directory, `--setting-sources ''`, no hooks or auto memory, only the stub
  MCP server, no slash commands.
- Never read the CLI's credentials. Refuse the `anthropic` provider when its credential is a subscription token;
  accept it with an API key.
- With `claude-cli`, compaction uses `haiku` and runs 2 calls at once instead of 8.

## Consequences

- A subscription works through a route Anthropic documents, and tools stay durable and under the host's
  `--allow-tools` rule.
- Each request costs a process start (about 0.5 s) and a full call against the plan's limits; compactions count too.
- Folding history into one prompt loses native message structure and thinking replay; caching covers the system
  prompt and tools, and part of the prompt.
- The CLI's preamble, environment block and managed settings still reach the model.
- The route depends on CLI flags and stream-json shapes of 2.1.303, and on a policy question without an official
  answer (whether such a wrapper is a third-party harness). It is for personal use; anything distributed must use API
  keys.
