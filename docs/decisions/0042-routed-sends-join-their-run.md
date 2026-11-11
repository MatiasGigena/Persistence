# 0042. Routed sends join a busy run on their own destination

## Status

Accepted, 2026-11-10. Amends [0028](0028-remote-machines-over-ssh.md): a routed user send to a busy Pi is no longer
always rejected.

## Context

With machine routing, every user message pins a destination, and a run executes on the one destination its inputs
agree on. ADR 0028 therefore rejected every user send while Pi's run was busy, steering included: pi-durable 1.3.0
could not compare the busy run's destination and admit the message in one step, and a check followed by an admission
could let another run start, or a steer for another machine land, in between.

`pi-durable serve` always routes, so the rule reached every client of a server. A message typed while Pi worked was
refused, on the phone and in the terminal alike; the web app's "Steer Pi…" mode never worked against a server; and
"also run the tests" had to wait for the answer and be typed again.

pi-durable 1.5.0 added `Conversation.submit(tx, draft)`: an admission inside the caller's own commit, stored with
the caller's reads and writes or not at all.

## Decision

- A routed send still binds its request ID to its destination first, in its own commit, so a refused request keeps
  its binding as before.
- The admission is then one commit that reads Pi's run and admits:
  - no run: the message starts one, as before;
  - a run on the same destination (machine, folder and label): the message is admitted as a follow-up, placed when the
    run answers, or with `steer` as a steer, placed after the current tool round;
  - a run on another destination, or one with no valid destination: refused, saying where Pi is busy. A run is never
    moved, and never takes an input for another machine.
- The run's destination is read before that commit, outside it, as tool calls read it: the run's stored pin, or
  before its first request stored one, the destination all its inputs are bound to. The commit admits only if the
  run and its inputs are still the ones read, and otherwise looks again, at most five times.
- A repeat of an admitted request ID returns the first submission, also while Pi is busy on another destination.
- Agent reports and scheduled wake-ups are unchanged: they queue as follow-ups with their own bindings.
- `PROTOCOL` stays 4. Nothing was added or removed on the wire; a send that was refused is now admitted when it
  can be. A client built for the old rule shows the message as sent; a new client against an old server shows the
  old refusal.

## Consequences

- From a workstation or the phone, a message typed while Pi works on the same destination is queued (the footer and
  the web header count it), and the web app's steer works. Esc still withdraws queued messages with the run.
- A workstation still cannot steer a run that executes on another workstation or on the server; the refusal names
  both destinations.
- If a run fails, the inputs queued behind it join the next run, as in pi-durable; should their destinations then
  differ, that run's tools fail closed (ADR 0028), as they already did for queued agent reports.
