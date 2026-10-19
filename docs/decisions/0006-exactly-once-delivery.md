# 0006. Exactly-once delivery across conversations

## Status

Accepted, 2026-10-19

## Context

A message or report crosses two conversations, and the host can die at any point, including SIGKILL. pi-durable
replays interrupted work. Without care, a replay resubmits an input (delivered twice), or a crash between an answer
and its report loses the report.

## Decision

- Every input is carried by one durable background task, `agents.deliver`.
- It submits with request id `agents:<taskId>`; pi-durable returns the first submission for a repeated id.
- For an agent target, it waits for the answer, then one commit records the answer id in the agent's `reported` list
  and creates the delivery task that carries `[Name] answer` to the parent.
- For Pi, it completes right after the durable admission and does not wait for Pi's answer.
- Tools that create deliveries (`spawn_agent`, `send_message`) are `replay: 'safe'` and store their result under the
  tool call's task id in the same commit; a replay returns it and creates nothing. `stop_agent` is `replay: 'unsafe'`.
- Each report entry carries `data.id` (the delivery task id), which keys it in Pi's memory log.

## Consequences

- Restart tests (close and reopen, SIGKILL and reopen) see each message and report exactly once.
- The registry keeps the last 256 tool results and the last 32 reported answers per agent.
- An `onReport` callback runs at most once per input; a crash right after the admission skips it. The
  `agents.report` entry is the durable record.
