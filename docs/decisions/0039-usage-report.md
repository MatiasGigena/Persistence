# 0039. A usage report: tokens per model, by day

## Status

Accepted, 2026-11-10.

## Context

The owner runs Pi and the standing agents on subscription plans with weekly limits, and could not see which model
the quota goes to.

- pi-durable counts every model response in its conversation's `pi.usage` document, and `harness.usage()` sums them:
  one total per `provider/model` for the whole chat, Pi and every agent. The totals have no dates.
- The memory's compactions call their model through pi-ai directly (`createPiAiSummarizer`), outside the Harness, and
  dropped the reply's usage. With `claude-cli`, each of them draws on the plan's limits like a turn does.

## Decision

- **One report, three periods.** `UsageReport` has `today`, `week` (the last 7 local days, today included) and `all`
  (all time), each a list of rows per model: input, output, cache read and cache write tokens, and the cost. `/usage`
  prints it in the terminal UI, the web app shows it under Chat settings, and both get it through
  `UiSession.usage()`, over the wire as the op `usage`. The op is additive, so `PROTOCOL` stays 4. Both front ends
  word it with the same functions (`src/ui/text.ts`).
- **Daily buckets, filled by sampling.** A session document, `host.usage` (version 1), holds the SDK's totals at the
  last sample (`last`), the spend per local day and model (`days`), and when counting began (`since`). A sample reads
  `harness.usage()` and, in one commit, adds what each total grew by since `last` to today's bucket. A work launch
  samples at its start, every five minutes, before every report, and when it closes. A sample that finds nothing new
  commits nothing, so an idle host writes nothing.
- **Why not a time series per request.** The SDK records usage inside its own commits and offers totals, not events.
  A ledger of requests would have to observe every model response of every conversation (Pi, the agents, the SDK's
  own compactions of agents, failed and aborted attempts) and would count again what `pi.usage` already counts, with
  two numbers that can drift apart; and it would grow with every request, forever. The questions asked are "what did
  today cost" and "what did this week cost", which need days, not requests. The buckets are small (63 days by a
  handful of models), and their sums always agree with the SDK's totals because they are differences of them.
- **Compactions are counted by the host.** `createPiAiSummarizer` takes `onUsage`, called once per reply, failed ones
  too. The tracker holds that spend in memory until the next sample, which adds it to the day and to `extra`, the
  all-time compaction spend. "All time" is `harness.usage()` plus `extra`.
- **The first sample only records.** What a chat spent before its first sample goes into `last`, into no day: it was
  not spent today. The report says since when days are counted.
- **Days are the host's local days**, as the memory's log files are (`localDay`). 62 days are kept besides today.
- **An inspection writes nothing.** `--status` and `--history` launches build the report from the stored document and
  the current totals.
- **Costs are pi-ai's catalog prices.** `claude-cli` reports none (docs/models.md), so its rows show tokens only. Tool
  results that report usage (`pi.usage.tools`) name no model and are left out; none of this host's tools reports any.

## Consequences

- `host.usage` is a persisted name, and so are its fields (`since`, `last`, `days`, `extra`, and a count's `input`,
  `output`, `cacheRead`, `cacheWrite`, `cost`). The op name `usage` is final.
- No migration: the document is created by the first sample, and an older checkout never reads it.
- A chat that existed before this version shows its earlier spend only in "all time", without the compactions of that
  time, which were never recorded.
- Spend is dated when it is sampled, not when it was made: up to five minutes before midnight may land on the next
  day, and what a host that crashed spent after its last sample lands on the day of its next launch. Compaction spend
  that was not sampled before a crash is lost; the SDK's own totals lose nothing.
- The 7 days are calendar days of the host's zone, so they approximate a plan's weekly window rather than match it.
  Changing the host's zone moves only the buckets filled afterwards.
- A sample reads one `pi.usage` document per conversation, so its cost grows with the number of agent sessions.
