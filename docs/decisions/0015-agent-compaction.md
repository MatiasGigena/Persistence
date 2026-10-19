# 0015. pi-durable compacts agents; Pi's compactions stay declined

## Status

Accepted, 2026-10-19. Amends [0002](0002-uniichat-memory.md) and [0003](0003-memory-only-for-pi.md).

## Context

The Harness had `settings: { compaction: { enabled: false } }`. pi-durable's settings apply to every conversation, so
agents were never compacted either, and they have no UniiChat view. A main agent lives as long as the chat and
wakes again for every message and every sub agent report, so its context grew until it passed the model's window.

Upstream UniiChat does not bound an agent either. Each agent call sends the master's view and the agent's whole log;
only each tool output is clipped to 30,000 characters. Its agents are short tasks, so this rarely matters there.
Our agents are persistent conversations, so it does.

pi-durable decides on a compaction from the last answer's reported usage plus an estimate of the messages after it.
Pi's requests are rewritten to the view, so that usage is the real, bounded size of Pi's request: Pi crosses the
threshold only inside a very long run. The `uniichat` extension already declines every compaction of the root
(`beforeCompact` returns `{ decline: true }`). After a declined compaction, the request goes on as it would have
without one.

## Decision

- The Harness gets `settings: { compaction: { enabled: true } }`, with pi-durable's default thresholds.
- Pi is unchanged: the `uniichat` extension declines its compactions, and its context stays the view.
- Agents get pi-durable's own compaction. Past the threshold, a summary on the agent's model replaces older history,
  and the recent turns stay verbatim. Agents still have no UniiChat memory ([0003](0003-memory-only-for-pi.md)).

## Consequences

- An agent's context stays below its model's window. Detail from before the summary is gone from its context. It
  stays in SQLite, and Pi still reads it with `zoom("Name")`, where a `note` line marks the cut.
- A compaction is one more call on the agent's model; with `claude-cli`, one more `claude` process.
- A very long Pi run can start a compaction that is declined at once: one short task, and no model call.
- The first message's copy of Pi's view is among the first things summarized away.
