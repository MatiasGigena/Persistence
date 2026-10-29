# Agents

Pi can start background agents, and has a team of standing agents that always exist. Each agent is its own persistent
pi-durable conversation (a standing agent, one per task), in the same database as Pi. The code is `src/agents/index.ts`
(the `agents` extension) and `src/agents/roster.ts` (the roster and kit names); the host wiring is in
`src/runtime/runtime.ts`. The design is [ADR 0027](decisions/0027-standing-agents.md).

## Contents

- [Roles](#roles)
- [Standing agents](#standing-agents)
- [Sessions: one per task](#sessions-one-per-task)
- [Permissions](#permissions)
- [The tools](#the-tools)
- [Messages, reports and entries](#messages-reports-and-entries)
- [Background execution](#background-execution)
- [Exactly-once delivery](#exactly-once-delivery)
- [Settings and tools on each launch](#settings-and-tools-on-each-launch)
- [Execution machines and session pins](#execution-machines-and-session-pins)
- [Reading an agent's chat](#reading-an-agents-chat)
- [Context size](#context-size)
- [The host: /agents and --resume](#the-host-agents-and---resume)
- [Known behaviors](#known-behaviors)

## Roles

| Role | Who | Created by |
|---|---|---|
| root | Pi, the session agent: the root conversation (`ROOT_CONVERSATION_ID`), with the UniiChat memory | the host |
| main | a main agent: a standing one, or one Pi spawned | the launch (standing), or Pi with `spawn_agent` |
| sub | a sub agent | a main agent, with `spawn_agent` |

```
Pi (root, session agent)
├── Lead (main)
│   ├── A (sub)
│   └── B (sub)
└── Docs (main)
    └── C (sub)
```

Sub agents cannot spawn, so the tree is at most three levels deep. `stop_agent` only stops an agent's current work;
Pi's `delete_agent` (or the host's `deleteAgent()`) removes an idle, non-standing agent and its sub agents from the
registry. Their conversations are not erased (the SDK has no such operation): they stay in the database, owned by
their finished anchor tasks, and the registry's `deleted` map keeps their ids, so `zoom("Name")` still reads the chat
(headed `Name was deleted; its chat is kept`). The name is free again for `spawn_agent`; a later delete of the same
name keeps only the newest chat's ids. Deleting is refused for Pi, a standing agent (or any roster name), and while
the agent or one of its subs is busy or has an `agents.deliver` input still on its way: `stop_agent` it first.

The registry is the session-scoped document `agents.registry`:

```js
{ agents: { [name]: { conversationId, role: 'main' | 'sub', parent: 'Pi' | mainName, reported: [answerIds],
                      standing?: true,               // a main agent of the roster
                      past?: [conversationIds],      // a standing agent's earlier sessions, oldest first
                      session?: conversationId } },  // a standing agent's sub: the session it works for
  calls: { [toolTaskId]: resultText },
  deleted?: { [name]: [conversationIds] } }          // agents removed with delete_agent, for zoom
```

`conversationId` is always the agent's current conversation. `standing`, `past` and `session` are absent on agents
that never had them, so older registries read unchanged.

Names match `/^[A-Za-z][A-Za-z0-9_-]{0,31}$/`, must not be `Pi`, and are unique. Lookups ignore case, both for
uniqueness and for addressing. A name starts with a letter because `zoom()` reads an id of digits as a message id.
The spawner picks the name; upstream UniiChat draws a random adjective and noun instead, but here agents address each
other by name, so a chosen one is easier to use. There is no limit on the number of agents, as upstream.

## Standing agents

The roster names the standing agents: main agents of Pi that every work launch creates when missing, in one idempotent
commit (`syncAgents`), with registry field `standing: true`. The built-in roster (`DEFAULT_ROSTER`):

| Name | Model | Effort | Tool kits |
|---|---|---|---|
| `Coder` | `claude-cli/opus` | `medium` | `coding` |
| `Reviewer` | `openai-codex/gpt-6.1-sol` | `xhigh` | `read`, `browser`, `autoreview` |
| `Researcher` | `openai-codex/gpt-6.1-sol` | `high` | `web_fetch` |

`settings.json` may replace it with an `"agents"` object keyed by name: `model` and `tools` (kits) are required,
`thinkingLevel` defaults to `high`, and `instructions` (added to the agent's role text), `subModel` and
`subThinkingLevel` are optional. An invalid entry is a launch error naming it. Only work launches read `agents`:
`--status`, `--history` and the admin commands (`backup`, `serve pair`, `serve devices`) ignore it, so a broken roster
never blocks a backup; writing `settings.json` (`/model`, `/effort`) keeps it as written.

- A name already taken by an ad-hoc agent makes that agent the standing one: it becomes a main agent of Pi, keeping its
  conversation. A sub agent of a standing agent also drops its `session`, so its reports and messages reach Pi.
- An agent removed from the roster stays, as an ordinary agent: `standing` is cleared and it follows Pi again.
- Pi may still `spawn_agent` other main agents ("ad-hoc agents"), for work no standing agent fits.

The tool kits:

| Kit | Tools |
|---|---|
| `coding` | `read`, `write`, `edit`, `bash`, through `GuardedEnv` as Pi's |
| `read` | `read` |
| `autoreview` | `autoreview`: the installed skill helper, fixed P0–P2, through guarded/routed execution; no general shell or editing tools |
| `browser` | `browser_goto`, `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`, `browser_screenshot`, `browser_close` |
| `web_fetch` | `web_fetch` |

A kit the host lacks gives its agents none of its tools, with one launch warning naming them (`missingKits`). The
agent tools come on top of the kits, as for every main agent.

### Reviewer: always /autoreview, through P2

For every code review the default Reviewer must read the installed `/autoreview` skill and call its dedicated
`autoreview` tool. The policy follows the kit into every task session and its subs, after custom instructions.
Debugging and browser checks do not replace a code review. The tool fixes `--max-priority P2` (P0, P1 and P2),
starts with Codex and the standalone CLI, and allows only Pi as an explicit fallback after a diagnosed, reported
Codex availability failure—not for slow progress, rate limits, isolation/safety refusals or unwanted findings.

Its arguments select `mode` (`local`, `branch`, `commit`), optional `repository`, `base`, `commit`, `prompt`,
`promptFiles`, `datasets` and fallback `engine`. Branch mode requires a base; local mode includes dirty and untracked
work; commit mode defaults to HEAD. No raw command, severity override, output path or isolation switch is exposed.
The existing guarded shell implementation runs only this fixed helper command, on the session's pinned machine;
SSH connectors use their existing bash permission check and durable execution ledger. Reviewer still has no
`bash`, `write` or `edit` tool and cannot message the Coder directly.

`--no-tools` and `/tools off` remove `autoreview` with the other local kits. Missing skills/credentials, failures,
filtered or incomplete reviews are blockers, never clean reports or a reason to substitute a manual review. Helper
exit codes and output are preserved (exit 1 can mean findings); interrupted calls are not automatically repeated.
The helper still owns Git capture, reviewer isolation, result validation and cleanup. Install its prerequisites on
**each execution machine** ([operations.md](operations.md#autoreview)). Nothing is copied from this repo or deployed
automatically. A custom `settings.json` roster replaces the default: add `"autoreview"` to its reviewer's `tools`
explicitly to retain this workflow. The host does not otherwise autoload ordinary Pi skills.

## Sessions: one per task

Only standing agents have sessions; an ad-hoc agent keeps one conversation.

- **`delegate(agent, task)`** (Pi only) starts a new task for a standing agent in a **new conversation**, owned by its
  own `agents.anchor` task of Pi's conversation, like a spawn. The registry's `conversationId` becomes the new session;
  the previous one is appended to `past`. The new conversation is derived (`deriveAgent`) before its first input,
  which carries Pi's view and `[from Pi] task`, exactly as a spawned agent's first input.
- A current session that holds no entry yet takes the task itself instead of being left empty in `past`: the launch's
  never-used first conversation (`past` becomes `[]`, session 1), or a session whose delegated task never arrived
  because its delivery failed or was aborted before submitting. So no empty session locks `delegate` out.
- `delegate` refuses while the agent's task is still going on:
  - a run in any of its sessions, current or past (`Coder is busy with its current task; send_message to steer it,
    or stop_agent first.`);
  - an unfinished `agents.deliver` task to its current session, such as the task of a delegate earlier in the same Pi
    turn or a `send_message` not yet answered (the same text), so two delegates in one turn cannot both start one;
  - a run in, or an unfinished delivery to, a sub agent of its current session: a main agent routinely hands work to
    a sub and ends its run, so it is idle while its task is not (`Coder's current task is still running (its sub
    agents Helper, Tester are busy); send_message to steer it, or stop_agent first.`).

  It also refuses for an agent that is not standing (`Lead is not a standing agent: give it the task with
  send_message, or spawn_agent a new agent under another name.`), for an unknown name, and for any caller but Pi. `stop_agent` clears every one of these: it stops
  the agent's sessions and its subs, and a stopped run's delivery ends.
- **`send_message`** to a standing agent goes to its current session: corrections, questions and steering of the task
  at hand. Its reports reach Pi as `[Coder] ...`, as any main agent's.
- Pi's role text says: a new request is `delegate`; a change to, or question about, the work in progress is
  `send_message`. Continuity between tasks comes from Pi's memory: each session starts with Pi's view.

**The previous task's sub agents.** A sub spawned by a standing agent records the session it works for (`session`).
`delegate` switches only when none of them is busy, so a task is never cut off; the subs stay in the registry with
their `session`, and later, if something wakes one:

- A sub whose `session` is not its main agent's current one reports nowhere: the commit that would create its report
  delivery sees the mismatch and creates none. Reports are routed by the parent's name when that commit runs, so this
  check is what keeps them out of the new session.
- A report delivery created just before the switch carries the old session's id; when it runs and finds that id in
  the agent's `past`, it completes without submitting, so the old session is not woken either.
- Such a sub's `send_message` to its main agent is refused (`Coder has moved on to a new task; the one you worked for
  is over.`).
- A later session that messages the sub (`send_message` from the main agent's current session) takes it on: its
  `session` becomes that one, and its reports come there.
- Anyone else's `send_message` to it (Pi, another agent, a sibling) is refused, since the sub would work and its report
  reach no one (`Helper worked for an earlier task of Coder, which is over: its report would reach no one. Coder can
  take it on by messaging it.`). Only the session it works for, if that one runs again, still reaches it.

**Past sessions stay quiet.** A message whose delivery finds its target in the agent's `past` goes to the agent's
current session instead, so a task that is over is not woken; since `delegate` waits for unfinished deliveries, that
happens only to deliveries from before that rule. Defensively, everything that reaches an agent reaches its past
sessions too: a run in one counts as busy (`list_agents`, `last_message`, `/agents`, the `<turn>` block's agents at
work), `stop_agent` and `stopAgents` abort them, and `syncAgents` re-derives them, so `/tools off` strips their local
kits as well. A past session is still the same agent (its role text and tools work).

## Permissions

| Action | Pi (root) | main | sub |
|---|---|---|---|
| `list_agents` | every agent | Pi and every other agent | every other agent, not Pi |
| `send_message` | any agent | any agent, and `Pi`; without coding tools: `Pi` and its own subs only | any agent except Pi; a sub of a main without coding tools: its main and its sibling subs only |
| `last_message` | any agent | any agent, and `Pi` | any agent except Pi |
| `spawn_agent` | yes: creates a main agent | yes: creates a sub agent | no |
| `delegate` | standing agents only | no | no |
| `stop_agent` | any agent | its own sub agents only | no |
| `delete_agent` | idle, non-standing agents | no | no |
| addressing `Pi` | (itself) | yes | no |

Nobody can `send_message` to itself. A main agent may message another main agent and its sub agents; only stopping is
limited to its own subs.

**Agents without coding tools stay in their team.** A standing agent whose roster kits lack `coding` (the default
Researcher and Reviewer), and each of its subs, are confined: the main agent may `send_message` only Pi and its own sub
agents, and its subs only their main agent and each other. The Researcher reads untrusted web pages; without this, a
page could have it tell the Coder to run a command (a prompt injection relayed to bash). The refusal reads
`Researcher cannot message Coder: agents without coding tools may message only Pi and their own sub agents.` (a sub's:
`... sub agents of an agent without coding tools may message only their main agent and its other sub agents.`).
`last_message` and `list_agents` only read, so they stay open. Agents with `coding`, ad-hoc agents (which copy Pi's
tools) and their subs keep the general rules; others may still message a confined agent. Whether an agent is confined
follows the roster's kits, not `/tools`.

The limits are enforced three times:

1. **Offer.** A sub's `modelTools` hide `spawn_agent` and `stop_agent`, so the model never sees them. No agent is
   offered `delegate` or `delete_agent`: `deriveAgent` drops them from the tools it copies from Pi. A confined agent's role text, and
   `send_message`'s description, state its messaging limit.
2. **Guard.** A `beforeTool` hook blocks `spawn_agent` and `stop_agent` from a sub, `send_message` or `last_message`
   that address `Pi`, a confined agent's `send_message` outside its team, and `delegate` from anyone but Pi, before
   the call's intent is recorded.
3. **Execute.** Each tool checks the caller's role (and `send_message` the confinement) again and returns a refusal
   text.

## The tools

What the model sees (descriptions abridged to their content):

| Tool | Parameters | Returns |
|---|---|---|
| `spawn_agent` | `name`, `task` | `Started main agent X. Its report will arrive as a message starting with [X].` (or `sub`); at once |
| `delegate` | `agent`, `task` | `Delegated to X (session n). Its report will arrive as a message starting with [X].`; at once |
| `list_agents` | none | one line per agent: `- Name (role, parent P[, standing]) busy or idle — last: <first 120 chars>` (`last (session n): ...` when it is from a past session) or `— no message yet`; Pi shows as `(session agent)` |
| `send_message` | `to`, `text` | `Sent to X.`; at once |
| `last_message` | `name` | `X is busy or idle. Last message:\n<text>` (`Last message (session n, an earlier task):` when it is from a past session) or `X is busy or idle. No message yet.` |
| `stop_agent` | `name` | `Stopped X.`, `Stopped X and its sub agents A, B.`; Pi stopping a sub also gets `Its main agent M is not told; message it if it should know.` |
| `delete_agent` | `name` | `Deleted X. Its chat stays readable with zoom("X").` or `Deleted X and its sub agents A, B. Their chats stay readable with zoom("X").`; refusals: `Only Pi can delete agents.`, `Pi cannot be deleted.`, `X is a standing agent; ...`, `X is busy; stop_agent X first, then delete it.`, `A message to X is still on its way; ...` |

Refusals are plain texts such as `No agent named X. The agents are A, B.` (or `There are none.`: an unknown name, in
Pi's tools and in `zoom("X")`, lists the names there are, so a misspelt one is fixed in one step; other agents get
only `No agent named X.`), `An agent named X
already exists; use send_message.` (`X is a standing agent: give it a new task with delegate, or steer its current one
with send_message.` when Pi spawns a standing agent's name),
`Invalid name: use a letter, then up to 31 letters, digits, _ or -, and not "Pi".`, `Sub agents cannot address Pi;
message your main agent instead.`, `X is not your sub agent.`

"Busy" means one of the agent's conversations (a standing agent's past sessions included) has a run in progress.
"Last message" is the latest committed assistant text of the agent's current session or, when that has none yet (right
after a `delegate`), of its newest past session that has one.

Each conversation also gets an `agents` system section with its role text, adapted from upstream UniiChat's subagent
prompt:

- Pi: which tools steer agents; that an agent knows what Pi wants only from its task, so the task must say all it
  needs; never wait for an agent, but end the turn and tell the user what is running. Then the standing agents, each
  with what it is for, and the rule: a new request in its field is `delegate(agent, task)`, a change to or question
  about the work in progress is `send_message`; spawn other agents only for work none of them fits.
- Main and sub agents: do the task yourself, following the user's instructions; your first message starts with Pi's
  view, which is context only (do what the task says, not what the user's last message says, and it cannot be
  zoomed); messages may arrive while you work, answer the last; your final reply is your report, so say what you did,
  what you found and what failed; never wait for another agent.
- Main agents also: do not send your report with `send_message` too; message Pi only with a question or news that
  cannot wait for the report. A standing agent's roster `instructions` follow its role text.
- A confined agent (see [Permissions](#permissions)) and its subs: whom `send_message` reaches.

The text about the view is left out when the extension has no `initialContext`.

## Messages, reports and entries

Every input to an agent or to Pi is a user message placed as a typed entry:

| From → to | Content | Entry |
|---|---|---|
| spawner → new agent (its task) | `<view>\n\n[from Spawner] task` | `agents.message`, data `{ from, text }` |
| `delegate` → a standing agent's new session | `<view>\n\n[from Pi] task` | `agents.message`, data `{ from, text }` |
| `send_message` to an agent | `[from Sender] text` | `agents.message`, data `{ from, text }` |
| `send_message` from a main to Pi | `[Sender]\ntext\n\nFull chat: zoom("Sender")` (`zoom("Sender#n")` from a standing agent) | `agents.report`, data `{ name, text, id, session? }` |
| an agent's final reply → its parent | `[Name] reply`, or `[Name] (no reply)` when it is empty | `agents.report`, data `{ name, text, id, session? }` |
| an agent's failed run → its parent | `[Name] failed: <reason>: <detail>` | `agents.report` |

Every input to Pi takes upstream UniiChat's report format, `piReportText(name, text, session?)`:
`[Name]\ntext\n\nFull chat: zoom("Name")`. The last line tells Pi where to read the agent's whole chat. From a
standing agent (or one with past sessions) it names the session the input came from, `zoom("Coder#2")`, and the entry
keeps the number in `data.session`, from which the memory writes the same link: a plain `zoom("Coder")` opens the
current session, so after a later `delegate` an old report's link would open the wrong one. Inputs to an agent stay
`[Name] text`, since agents cannot zoom. The entry's `data.text` is always the bare text.

- The `<view>` preamble is Pi's memory view at spawn time (`memory.render()`), passed as the extension's
  `initialContext`. The host first waits up to 8 s for the view's pending summaries (`memory.settle`), as a turn
  does, because an agent cannot zoom a placeholder; upstream also waits. Sub agents get Pi's view too. Only the first
  input carries it.
- `id` is the delivery task's id. It is added when the entry is placed, so the memory logs each report once, even two
  identical ones (`src` = `report:<id>`, see [memory.md](memory.md#idempotency-via-src)).
- In Pi's memory, an `agents.report` input is logged as a `work` message built from its data by `Memory.report()`,
  never as `user`.
- An aborted run (for example after `stop_agent`) reports nothing: its stopper knows. Upstream logs a stopped agent's
  report in the master's chat without starting a turn; here Pi's own `stop_agent` result is in its memory instead.

## Background execution

Agents run in background tasks. Nobody waits for anybody:

- `spawn_agent`, `delegate` and `send_message` return at once. The prompts of every role say: never wait for an agent, no sleep,
  no polling; go on, or end the turn.
- A main agent's reply at the end of each run goes to Pi. A sub agent's goes to its main agent. A report to a busy
  parent is queued as a follow-up, after its current run. `send_message` steers: a busy receiver sees it between its
  tool calls; an idle one starts a run.
- A report to Pi starts an ordinary Pi run. No host submission waits for it. In chat, the host watches the root and
  prints each new `agents.report` entry and each reply of Pi as it lands.
- Each Pi run's `<turn>` block lists the agents at work (`agents at work: Lead, A` or `none`), as upstream tells its
  master. The host wires the `uniichat` extension's `atWork` to the busy agents of `listAgents()`.
- Reports flow one level up. A sub's report reaches Pi only if its main agent relays it.

Each agent's conversation is owned by an `agents.anchor` task, created as a background task of the spawner's
conversation. So `root.waitForIdle()` and `root.abort()` do not reach agents; only
`root.abort(ctx, { background: true })` does.

`stop_agent` aborts the agent's conversations (a standing agent's past sessions too) through
`stopAgents(source, context, name)`. Stopping a main agent first stops each of its sub agents, since a sub's report would otherwise wake the stopped main again. Without a name,
`stopAgents` stops every agent, subs first, and leaves Pi alone: it is the agent half of upstream's stop of all work,
for a host command. The terminal UI's `/stop` and Esc still interrupt only Pi.

## Exactly-once delivery

Agents, Pi and the host may stop at any point, including SIGKILL. Every input must arrive once and every answer must
be reported once.

**Delivery tasks.** Each input is carried by one durable background task, `agents.deliver`, with input
`{ to, conversationId, content, entry, whenBusy }`:

1. It submits the input to the target conversation with request id `agents:<taskId>`. pi-durable deduplicates by
   request id within a conversation, so a resubmission after a restart returns the first submission. A message whose
   target is in the agent's `past` goes to its current session instead (a report there is dropped): unless the
   request already reached the past session, the task picks the current session in a commit, from the registry as it
   is then (not from an older snapshot), stores it in its memo `session` before it submits, and a rerun reads the
   memo, so a replay submits to the same conversation and the input arrives once. Until the memo exists, `delegate`'s
   check of unfinished deliveries counts such a delivery for the agent's current session, so no delegate can turn
   the session it picks past in between.
2. If the target is Pi, it completes right after the submit (the admission is durable) and calls `onReport` at most
   once. It does not wait for Pi's answer.
3. Otherwise it waits for the submission to settle. Then **one commit** records the answer id in the agent's
   `reported` list and creates the next delivery task, which carries `[Name] answer` to the parent. A restart can
   repeat the wait, but not the report: the commit either happened or did not.
4. `reported` (the last 32 answer ids) also covers two inputs answered by the same run, for example a steered message
   and the task it joined: the second delivery finds the answer already reported.

**Anchor tasks.** `agents.anchor` completes at once. It exists so the agent's conversation has a background owner.

**Replay-safe tools.** `spawn_agent`, `delegate`, `send_message`, `list_agents` and `last_message` are
`replay: 'safe'`. The three that create deliveries run their change through `once()`: the result is stored in
`registry.calls` under the tool call's task id, in the same commit as the change. A replayed call returns the stored
result and creates nothing. The last 256 results are kept. `spawn_agent` and `delegate` also skip `initialContext` on a
replay. `delegate` decides busy again inside its commit (unfinished deliveries, an empty session, the current
session unchanged), so a rerun after a crash before the commit decides afresh, and one after it returns the stored
result. `stop_agent` is `replay: 'unsafe'`: rerunning it after a crash could stop newer work.

The tests in `test/agents/agents.test.ts` close and reopen, and SIGKILL and reopen, with a delivery in flight, and
check that each message and report appears exactly once. `test/agents/sessions.test.ts` reopens with a delegated task
still undelivered and replays the call.

## Settings and tools on each launch

Every agent is re-derived from Pi at spawn (or delegate) and again at every work launch (`deriveAgent`):

```js
await root.configure(agent, context);                               // this launch's choices for Pi
await syncAgents(harness, context, { childAgent, roster, kits });   // create missing standing agents, re-derive all
```

`deriveAgent` takes these steps, in order:

1. **Copy Pi.** Model, thinking level, extensions, tools, model tools, cwd and instructions.
2. **Standing agents and their subs.** A standing agent's roster entry overrides model, thinking level and tools: its
   tools become the five agent tools plus its kits' tools, and each kit's extension is selected. A sub of a standing
   agent takes its main agent's entry, then `subModel` and `subThinkingLevel` when given. The local kits (`coding`,
   `read`, `autoreview`) apply only while Pi's coding tools are on; `browser` and `web_fetch` stay offered, since they touch no local
   files. Their calls refuse in remote-target sessions until remote network-kit support exists.
   Its instructions are Pi's with Pi's coding-tools line (the one naming bash) replaced by its own: the kit tools it
   has now, the protected-folders note only while it has a local kit's tools, which of its local tools are off, and
   that it cannot change files or run commands when it lacks bash. So the Researcher is never told it has `bash`.
3. **Role offer.** `delegate` leaves every agent's tools; a sub's `modelTools` hide `spawn_agent` and `stop_agent`.
4. **The host's `childAgent` change:**

   ```js
   const childAgent = { extensions: { remove: [Unii] } };
   ```

   This removes the `uniichat` extension, with its `zoom` and `date` tools, its system section and its request
   rewrite: an agent sees its own conversation, not a view ([ADR 0003](decisions/0003-memory-only-for-pi.md)). The
   kits' extensions are selected after it, so it cannot drop them.

So an ad-hoc agent follows the current launch: `--model`, `--thinking`, `--cwd` and `--no-tools`; its tools are the
five agent tools (three offered to a sub), plus `read`, `write`, `edit` and `bash` unless coding tools are off. A
standing agent and its subs keep the roster's model and effort through `/model` and `/effort`, which change Pi and its
ad-hoc agents only; `--no-tools` and `/tools off` remove their local kits. The terminal UI's `/model`, `/effort` and
`/tools` take the same two steps mid-launch (`Instance.setModel`, `setThinkingLevel`, `setTools`), so agents follow
them from their next request. A standing agent's past sessions are re-derived with its current one, since a past
session can still run: `/tools off` reaches them too.

## Execution machines and session pins

With machine routing enabled ([ADR 0028](decisions/0028-remote-machines-over-ssh.md)),
model requests, agent state and delivery stay on the central server; coding/read
tools and autoreview's fixed helper command run on an immutable `{machineId, cwd, label}` destination:

- A routed user message binds its request ID and root run to its destination. A
  busy root rejects routed user sends, rather than steering an existing run onto
  another machine.
- `spawn_agent` inherits the caller's destination in the same transaction that
  creates the child. The pin is separate from its agent config, so `/model`,
  `/effort`, `/tools`, launch cwd and recovery cannot retarget it.
- `delegate` pins a standing agent's new session to the delegating run. The
  standing agent's earlier sessions and their subs keep their original pins.
  A first, empty session may take its first task, but an existing pin is never
  overwritten. `send_message` addresses an existing session, not the sender's
  machine: it never moves that session's tools.
- Every **new** delivery to Pi from a pinned agent binds `agents:<delivery task ID>`
  to its actual source conversation in the same commit that schedules the delivery,
  before its input can be submitted. An automatic report inherits the conversation
  whose answer it carries; `send_message("Pi", ...)` inherits the calling session.
  Neither looks up the standing agent's mutable current session. A report-only root
  run can therefore use coding tools and delegate the next stage on that same machine
  (for example, Coder → Pi → Reviewer), without another user message.
- Every input in a root run must have an explicit, matching destination. Reports
  joining user input are validated too: distinct machines/cwds, or any unmapped
  legacy input, block execution rather than selecting either destination.
- Older agents/sessions and already-scheduled deliveries without a pin fail closed
  for coding tools and spawning/delegation; they do not acquire an implicit server
  destination or borrow a neighboring input's pin. Their text is still delivered
  and Pi may answer. Submit a new user task with an explicit destination to restart
  the workflow.
- An offline or disabled connector leaves calls waiting for the same machine and
  exact launch cwd, never another workstation or the VPS. Its own per-process
  coding/read grant is required in addition to the server gate; it starts off
  unless the remote launch explicitly uses `--allow-tools` or `/tools on`.
- The workstation connector supports coding/read kits and autoreview's fixed helper command. A
  remote-target session's `browser_*` and `web_fetch` calls refuse, never run on
  the server as a fallback. This includes the Researcher's fetches. Server-target
  sessions keep the browser/web-fetch kits and their existing egress checks.

The execution machine uses `GuardedEnv`: state and credentials hidden, system
folders read-only, bash in bubblewrap. Its cwd pin is routing scope, not a
project-only sandbox. Calls have stable execution IDs and a local fsynced ledger;
unknown outcomes after a worker crash return `INDETERMINATE` instead of rerunning.
Exactly-once **agent delivery** does not promise exactly-once arbitrary bash
side effects. Details and shutdown limitations:
[operations.md](operations.md#remote-workstations-over-ssh).

## Reading an agent's chat

Pi's `zoom("Name")` returns `agentTranscript(harness, name, context, page?)`: the agent's whole conversation, oldest
first, in the format of upstream UniiChat's agent log, one `i|kind: text` line per message with a blank line between:

```
0|note: the first message also held Pi's view at the spawn (not shown)

1|user: [from Pi] Plan the work.

2|tool: spawn_agent({"name":"B","task":"Do part B."})

3|echo: spawn_agent: Started sub agent B. Its report will arrive as a message starting with [B].

4|Lead: Delegated to A and B.
```

- `user` is an input, rendered from its entry: `[from X] text` for a message, `[X] text` for a report. The view
  preamble is left out and marked by a `note`.
- The agent's replies carry its name; `tool` lines are its calls and `echo` lines their results, whole.
- A `note` also marks where pi-durable compacted the agent's context. Every message is still shown.
- The text comes in pages of at most 30,000 characters (`TRANSCRIPT_PAGE`, upstream's `CAP`), cut after a line end,
  each but the last ending `[page n of N; go on with page n+1]`. `zoom("Name", 1, page)` passes its page; a short
  chat is one page. `agentTranscript` without a page returns the whole chat.

A standing agent's chat is one session: `zoom("Coder")` reads the current one, `zoom("Coder#2")` the second (1 is the
oldest, the current one is the last). Its reports to Pi link the session they came from (`zoom("Coder#2")`). Its first line says which, before the numbered lines:

```
session 2 of 3

0|note: the first message also held Pi's view at the spawn (not shown)

1|user: [from Pi] Fix the login form.
```

The current session's line ends ` (current)`. Pages work as above (`zoom("Coder#2", 1, page)`); the session line opens
the first page. An ad-hoc agent has no session line. An unknown session is a plain text, `No session 4: Coder has 3
sessions.`

`zoom("Pi")` gives Pi's own transcript. An unknown name is an error (`No agent named X`).

## Context size

pi-durable compacts each agent's conversation: past its threshold (near the model's context window), a summary on the
agent's model replaces older history and the recent turns stay verbatim. Pi's compactions are declined by the
`uniichat` extension, so Pi's context stays its view. See [ADR 0015](decisions/0015-agent-compaction.md). Upstream
UniiChat bounds nothing here: each agent call sends the view and the agent's whole log, with each tool output clipped
to 30,000 characters.

## The host: /agents and --resume

- **Agents progress only while a host is open.** There is no daemon. Delivery tasks and agent runs are background
  tasks of the host process, and pi-durable's scheduler starts when the host resumes pending work or submits a message.
  Closed work stays pending and continues at the next launch that runs work.
- **`/agents`** in chat lists every agent as `Name (role, parent P) busy or idle`, or `No agents yet. Ask Pi to spawn
  one.`
- **`--resume`** finishes interrupted work, then waits for the agents: it resumes the scheduler, waits until Pi is idle
  and every remaining task is an `agents.anchor` task (polling every 250 ms), then prints the transcript. A report that
  starts a new Pi run keeps it waiting. Ctrl+C ends the wait.
- **`-p` / `--print`** waits only for its own answer. Agents it starts keep running only until the process exits, and
  continue at the next launch.
- **`--status` and `--history`** run no work.

## Known behaviors

- **Two reports from one main agent.** A main agent that calls `send_message("Pi", …)` and then finishes produces two
  `agents.report` entries for Pi: the message, then the final reply. Each starts a Pi run, so Pi answers twice.
  Upstream cannot do this (its subagents cannot message the master). The main agent's prompt asks it to message Pi
  only with a question or urgent news, never with its report.
- **Every run reports.** A main agent that is woken again (by a sub's report or a message) reports again at the end
  of that run. In the restart test, M reports `M waiting`, then `M relays: S finished`.
- **Failures report, stops do not.** A run that ends unanswered reports `[Name] failed: <reason>: <detail>`; an
  aborted run reports nothing. When Pi stops a sub agent, the sub's main agent is not told; the tool result says so.
- **An empty reply still reports.** It reaches the parent as `[Name] (no reply)`, as upstream reports every run.
- **Agents never see Pi's later view.** The view is only in an agent's first input (a standing agent's: in each
  session's first input, so each task starts from the view of its delegate). Later, it can ask Pi
  (`send_message("Pi", …)`, mains only) or read `last_message("Pi")`. Upstream starts each agent call afresh with the
  current view and the agent's log; a persistent conversation would grow by a whole view on every run instead.
- **Agents cannot zoom.** Upstream gives its subagents `zoom` and `date` on the master's memory. Here the `uniichat`
  extension, which holds those tools, is removed from agents ([ADR 0003](decisions/0003-memory-only-for-pi.md)).
- **`onReport` is not used by the host.** The extension accepts an `onReport` callback, but the host does not pass
  one. Pi's memory logs a report when Pi's next request sees its `agents.report` entry.
