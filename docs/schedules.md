# Schedules

Pi can leave itself a message for later: a reminder for you, or a check on something that is not ready yet. The code
is `src/schedule/` (the `schedule` extension); the host wiring is in `src/runtime/runtime.ts`. The design is
[ADR 0038](decisions/0038-scheduled-wake-ups.md).

## For the user

Ask Pi in words: "remind me on Friday at 10 to call the bank", "check the build again in 20 minutes", "every weekday
at 9, tell me what changed in the repos overnight". Pi answers with what it scheduled.

- `/schedule` in the terminal lists the schedules, and `/schedule cancel N` removes one. The web app shows
  `N scheduled` under the header; tap it for the list and its Cancel buttons. `/status` names the next one.
- When a schedule is due, its message arrives as a new turn, shown as `[Schedule #N] text`, and Pi answers it. With
  `pi-durable serve` and [push notifications](operations.md#push-notifications), a phone is told both that the
  schedule fired and that Pi answered.
- Times are the host's local time. For a server in another zone than yours, set `TZ` in its environment file
  (`TZ=America/Argentina/Buenos_Aires`), or give Pi times with an offset.
- A host that is not running delivers nothing. A local chat delivers what came due while it was closed at its next
  launch, marked late; a repeating schedule then fires once, not once per missed time.
- Every wake-up is a model run. A repeating schedule runs until it is cancelled.

## The tools

Only Pi has them; agents and code mode scripts do not.

| Tool | Arguments | Result |
|---|---|---|
| `schedule` | `text`, and exactly one of `at`, `in_minutes`, `cron` | `Scheduled #3 for 2026-11-12 09:00:00 -03:00 (Thursday). cancel_schedule(3) cancels it.` |
| `list_schedules` | — | the current time, then one line per schedule: `#3 once 2026-11-12 09:00:00 -03:00 (Thursday): text` |
| `cancel_schedule` | `id` | `Cancelled #3 (once): text` |

- `at`: an ISO 8601 date and time, `2026-11-12T09:00` (the host's local time) or `2026-11-12T09:00-03:00`. A date
  without a time is refused, as is a time in the past or more than two years ahead.
- `in_minutes`: at least 1.
- `cron`: five fields, `minute hour day-of-month month day-of-week`, in the host's local time. Each field takes `*`,
  a value, a range `a-b`, a step `*/n` or `a-b/n`, and lists of those with commas; months and weekdays also by name
  (`jan`, `mon`), and 7 is Sunday. With both day fields restricted a day matches either, as in Vixie cron. An
  expression that fires more often than every 5 minutes is refused.
- At most 32 schedules; a text of at most 4,000 characters.

A refusal is the tool's text, written so the model can correct the call: `at 2026-11-10T13:00 is in the past: now is
2026-11-10 14:00:00 -03:00 (Tuesday).`

## What a wake-up is

```
schedule(...)  ─►  schedule.registry: { next, items: { "3": { taskId, text, at, createdAt, fired, cron? } }, calls }
               └►  task schedule.wake { id, at, target? }      background, owned by Pi's conversation
                     wait:  sleepUntil(at)                      durable; no invocation while asleep
                     fire:  no record ─► end
                            submit to Pi: input "[Schedule #3] text …", entry schedule.fire, followUp,
                                          requestId schedule:<task id>:<occurrence>
                            commit: repeating ─► record.at = next, sleep until it;  one-off ─► remove the record, end
```

- The submit and the commit after it are two steps. A crash between them reruns the `fire` phase: the request ID
  returns the first submission, so Pi gets the message once ([ADR 0006](decisions/0006-exactly-once-delivery.md)).
- The tools are replay-safe: the registry's `calls` maps a tool task ID to its first result, as the agents' registry
  does, so a call rerun after a crash schedules nothing twice.
- A delivery that fails (not a closing host, which just reruns it) is reported and tried again a minute later, five
  times; then the schedule is dropped with a report, rather than listed forever without firing.
- An aborted `schedule.wake` task removes its record.
- The message is `[Schedule #3] text`, a blank line, and `(A wake-up you scheduled on …, due …[; delivered late, at
  …: the host was not running then].[ It repeats (cron "…", next …); cancel_schedule(3) stops it.])`. Late means more
  than two minutes after it was due.
- The entry's data is `{ id, text, due, cron? }`. The memory logs the message as `work`
  ([memory.md](memory.md#kinds)); the feed shows a `report` item from `Schedule #3` with the text alone.

## Machines

With machine routing ([ADR 0028](decisions/0028-remote-machines-over-ssh.md)) every input of Pi's needs a pinned
destination. A schedule takes the destination of the run that made it:

- made in a run on a workstation, the task keeps that machine and folder, and each wake-up's request is pinned to it
  before it is submitted. The tool's result says so (`Its tools run on My laptop, in /home/me/project.`). If the
  workstation is offline then, the run starts and its first coding tool call waits for it;
- made in a run on the server, the task keeps no machine, and each wake-up is pinned to the server as it is then.

A run with no valid destination cannot schedule.

## Host API

`src/schedule/index.ts` exports `listSchedules(source, context)` (soonest first) and `cancelSchedule(harness, context,
id)`, which removes the record, aborts the task, and throws `NotFound` for an unknown id. The session
(`src/session/session.ts`) puts the schedules in the status, each text cut to a one-line preview of 200 characters, and
serves `cancelSchedule(id)`.
