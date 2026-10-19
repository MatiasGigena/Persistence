# 0007. Cheap compaction model, size enforced by a cut

## Status

Accepted, 2026-10-19

## Context

The compactor runs for every message over 512 bytes and every merge that does not fit, up to 8 at a time, for the
life of the chat. It must be cheap. The recipe uses Claude Haiku and asks the model to rewrite a too-long line up to 5
times. pi-endless measured cheap models repeating the same over-long line on every retry.

## Decision

- The compaction model is the turn provider's cheap model when the catalog has it: `gpt-6-luna` for `openai-codex`
  and `openai`. With the default turn model `openai-codex/gpt-6.1-sol`, that is `openai-codex/gpt-6-luna`
  ($0.10/$0.50 per million tokens against $2/$10). Other providers use the turn model.
- It runs at `reasoning: 'low'`, with `maxTokens` 4,000 (400 for a model without reasoning) and a 120 s timeout.
- An over-long line gets one "Too long" retry in the same conversation (`tooLongRetries = 1`). The shorter reply is
  kept, then `cutLine` cuts it to 512 bytes at the last `; ` or sentence end, else comma, past half the limit.
- The host has no flag for it; `openMemory` accepts `compactionModel` or a custom `summarize`.

## Consequences

- At most two calls per node, and every node fits 512 bytes regardless of the model.
- A cut drops the line's tail, whatever its value. The prompt does not ask for the most valuable items first.
- Changing `--model` to another provider makes compaction as expensive as turns.
