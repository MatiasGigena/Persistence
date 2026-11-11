# 0038. Scheduled wake-ups

## Status

Accepted, 2026-11-10. Extends [0005](0005-background-agents.md) and [0006](0006-exactly-once-delivery.md); uses the
routing of [0028](0028-remote-machines-over-ssh.md).

## Context

The chat never ends, and with `pi-durable serve` its host runs for weeks, but Pi acted only when spoken to: by the
user, or by an agent's report. It could not be asked to "remind me on Friday", to "look at the deploy again in twenty
minutes", or to "summarize the repos every weekday morning". Its instructions forbid waiting and polling, so a check
that was not ready yet was simply dropped.

pi-durable 1.4.0 added durable sleeps: a task ends a phase asleep (`sleepUntil`), holds no invocation meanwhile,
survives restarts, and resumes once the Harness clock reaches the time.

## Decision

- Pi gets three tools, `schedule(text, at | in_minutes | cron)`, `list_schedules()` and `cancel_schedule(id)`, in a new
  extension `schedule` (`src/schedule/`). A schedule is a message Pi leaves itself. `at` is an ISO date and time,
  `in_minutes` a delay, `cron` a five-field expression that repeats; times without an offset, and cron fields, are
  the host's local time.
- Each schedule is a `schedule.wake` task of Pi's conversation, in the background as an agent's deliveries are, so
  Pi's Esc and idle waits never reach it. It sleeps until the schedule is due, submits the message to Pi as a
  follow-up input with the request ID `schedule:<task id>:<occurrence>`, then in one commit sleeps until the next
  occurrence or ends. A crash between the submit and that commit reruns the phase, and the request ID returns the
  first submission: a wake-up arrives exactly once.
- The session document `schedule.registry` lists the schedules. Cancelling one removes its record; its task finds
  none when it wakes and ends without submitting. The host also aborts the task, so it does not linger.
- A wake-up is placed as the entry `schedule.fire` with `{ id, text, due, cron? }`. Its model text is
  `[Schedule #n] text` and one line of context. The memory logs it as `work`, the kind for what a background task
  reports, never as the user's words. Clients show it as a `report` item from `Schedule #n`: no new chat item kind,
  so the protocol version stays, and the server's push for reports tells a phone that a reminder fired.
- A host that was closed when a schedule came due delivers it at its next work launch, saying it is late. A
  repeating schedule then skips the occurrences it missed: one late wake-up, not one per missed day.
- Limits, since every wake-up is a model run the user pays for: at most 32 schedules, a repeating one at most every
  5 minutes, a one-off at most two years ahead, a text of at most 4,000 characters.
- With machine routing, a schedule made in a run on a remote machine keeps that machine for its wake-ups, as a
  spawned agent does. One made in a run on the server stores no machine: its wake-ups are pinned to the server as it
  is then, because the server's folder may change between launches and a stored one would then fail closed.
- Only Pi schedules. The host removes the extension from every agent, as it does the memory, and the tools refuse
  any other conversation. Scripts in code mode cannot call them.
- The status carries the schedules (`status.schedules`, an optional field), `/schedule` lists them in the terminal
  and the web app shows them in a sheet. The op `schedule.cancel` removes one. Creating one is asked of Pi.
- A sleeping `schedule.wake` task is not pending work: `--resume` and the "Resuming…" line leave it out.

## Consequences

- New persisted names, frozen from now on: the extension `schedule`, the task kind `schedule.wake`, the document
  kind `schedule.registry`, the entry kind `schedule.fire`, the tools `schedule`, `list_schedules` and
  `cancel_schedule`, the op `schedule.cancel`, and the request ID prefix `schedule:`.
- A wake-up needs a running host. On a laptop that is closed, reminders arrive when it is next opened; on a server
  they arrive on time, also while no client is attached.
- A wake-up pinned to a workstation that is offline starts its run anyway; a coding tool call then waits for that
  machine (ADR 0028), and Pi's chat is busy until it connects or the user stops the run.
- The Harness now takes the host's clock (`InstanceOptions.clock`), so tests move time; an inspection launch runs no
  task and keeps the default.
- Cron expressions follow the host's zone, including its clock changes: a local time a change skips does not fire
  that day, and one it repeats fires once.
