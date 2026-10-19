# Agents

Pi can start background agents. Each agent is its own persistent pi-durable conversation, in the same database as
Pi. The code is `src/agents/index.ts` (the `agents` extension); the host wiring is in `src/runtime/runtime.ts`.

## Contents

- [Roles](#roles)
- [Permissions](#permissions)
- [The tools](#the-tools)
- [Messages, reports and entries](#messages-reports-and-entries)
- [Background execution](#background-execution)
- [Exactly-once delivery](#exactly-once-delivery)
- [Settings and tools on each launch](#settings-and-tools-on-each-launch)
- [Reading an agent's chat](#reading-an-agents-chat)
- [The host: /agents and --resume](#the-host-agents-and---resume)
- [Known behaviors](#known-behaviors)

## Roles

| Role | Who | Created by |
|---|---|---|
| root | Pi, the session agent: the root conversation (`ROOT_CONVERSATION_ID`), with the UniiChat memory | the host |
| main | a main agent | Pi, with `spawn_agent` |
| sub | a sub agent | a main agent, with `spawn_agent` |

```
Pi (root, session agent)
├── Lead (main)
│   ├── A (sub)
│   └── B (sub)
└── Docs (main)
    └── C (sub)
```

Sub agents cannot spawn, so the tree is at most three levels deep. Agents are never deleted; `stop_agent` only stops
their current work.

The registry is the session-scoped document `agents.registry`:

```js
{ agents: { [name]: { conversationId, role: 'main' | 'sub', parent: 'Pi' | mainName, reported: [answerIds] },
  calls: { [toolTaskId]: resultText } }
```

Names match `/^[A-Za-z0-9_-]{1,32}$/`, must not be `Pi`, and are unique. Lookups ignore case, both for uniqueness
and for addressing.

## Permissions

| Action | Pi (root) | main | sub |
|---|---|---|---|
| `list_agents` | every agent | Pi and every other agent | every other agent, not Pi |
| `send_message` | any agent | any agent, and `Pi` | any agent except Pi |
| `last_message` | any agent | any agent, and `Pi` | any agent except Pi |
| `spawn_agent` | yes: creates a main agent | yes: creates a sub agent | no |
| `stop_agent` | any agent | its own sub agents only | no |
| addressing `Pi` | (itself) | yes | no |

Nobody can `send_message` to itself. A main agent may message another main agent and its sub agents; only stopping is
limited to its own subs.

The sub limits are enforced three times:

1. **Offer.** A sub's `modelTools` hide `spawn_agent` and `stop_agent`, so the model never sees them.
2. **Guard.** A `beforeTool` hook blocks `spawn_agent` and `stop_agent` from a sub, and `send_message` or
   `last_message` that address `Pi`, before the call's intent is recorded.
3. **Execute.** Each tool checks the caller's role again and returns a refusal text.

## The tools

What the model sees (descriptions abridged to their content):

| Tool | Parameters | Returns |
|---|---|---|
| `spawn_agent` | `name`, `task` | `Started main agent X. Its report will arrive as a message starting with [X].` (or `sub`); at once |
| `list_agents` | none | one line per agent: `- Name (role, parent P) busy or idle — last: <first 120 chars>` or `— no message yet`; Pi shows as `(session agent)` |
| `send_message` | `to`, `text` | `Sent to X.`; at once |
| `last_message` | `name` | `X is busy or idle. Last message:\n<text>` or `X is busy or idle. No message yet.` |
| `stop_agent` | `name` | `Stopped X.` |

Refusals are plain texts such as `No agent named X.`, `An agent named X already exists; use send_message.`,
`Invalid name: use 1–32 letters, digits, _ or -, and not "Pi".`, `Sub agents cannot address Pi; message your main
agent instead.`, `X is not your sub agent.`

"Busy" means the agent's conversation has a run in progress. "Last message" is the latest committed assistant text.

Each conversation also gets an `agents` system section with its role text: who it is, which tools it may use, how
messages and reports reach it, that its final reply is reported automatically, and that it must never wait for
another agent.

## Messages, reports and entries

Every input to an agent or to Pi is a user message placed as a typed entry:

| From → to | Content | Entry |
|---|---|---|
| spawner → new agent (its task) | `<view>\n\n[from Spawner] task` | `agents.message`, data `{ from, text }` |
| `send_message` to an agent | `[from Sender] text` | `agents.message`, data `{ from, text }` |
| `send_message` from a main to Pi | `[Sender] text` | `agents.report`, data `{ name, text, id }` |
| an agent's final reply → its parent | `[Name] reply` | `agents.report`, data `{ name, text, id }` |
| an agent's failed run → its parent | `[Name] failed: <reason>` | `agents.report` |

- The `<view>` preamble is Pi's memory view at spawn time (`memory.render()`), passed as the extension's
  `initialContext`. Sub agents get Pi's view too. Only the first input carries it.
- `id` is the delivery task's id. It is added when the entry is placed, so the memory logs each report once, even two
  identical ones (`src` = `report:<id>`, see [memory.md](memory.md#idempotency-via-src)).
- In Pi's memory, an `agents.report` input is logged as a `work` message `[Name] text`, never as `user`.
- An aborted run (for example after `stop_agent`) reports nothing.

## Background execution

Agents run in background tasks. Nobody waits for anybody:

- `spawn_agent` and `send_message` return at once. The prompts of every role say: never wait for an agent, no sleep,
  no polling; go on, or end the turn.
- A main agent's reply at the end of each run goes to Pi. A sub agent's goes to its main agent. A report to a busy
  parent is queued as a follow-up, after its current run. `send_message` steers: a busy receiver sees it between its
  tool calls; an idle one starts a run.
- A report to Pi starts an ordinary Pi run. No host submission waits for it. In chat, the host watches the root and
  prints each new `agents.report` entry and each reply of Pi as it lands.
- Reports flow one level up. A sub's report reaches Pi only if its main agent relays it.

Each agent's conversation is owned by an `agents.anchor` task, created as a background task of the spawner's
conversation. So `root.waitForIdle()` and `root.abort()` do not reach agents; only
`root.abort(ctx, { background: true })` does.

## Exactly-once delivery

Agents, Pi and the host may stop at any point, including SIGKILL. Every input must arrive once and every answer must
be reported once.

**Delivery tasks.** Each input is carried by one durable background task, `agents.deliver`, with input
`{ to, conversationId, content, entry, whenBusy }`:

1. It submits the input to the target conversation with request id `agents:<taskId>`. pi-durable deduplicates by
   request id, so a resubmission after a restart returns the first submission.
2. If the target is Pi, it completes right after the submit (the admission is durable) and calls `onReport` at most
   once. It does not wait for Pi's answer.
3. Otherwise it waits for the submission to settle. Then **one commit** records the answer id in the agent's
   `reported` list and creates the next delivery task, which carries `[Name] answer` to the parent. A restart can
   repeat the wait, but not the report: the commit either happened or did not.
4. `reported` (the last 32 answer ids) also covers two inputs answered by the same run, for example a steered message
   and the task it joined: the second delivery finds the answer already reported.

**Anchor tasks.** `agents.anchor` completes at once. It exists so the agent's conversation has a background owner.

**Replay-safe tools.** `spawn_agent`, `send_message`, `list_agents` and `last_message` are `replay: 'safe'`. The two
that create deliveries run their change through `once()`: the result is stored in `registry.calls` under the tool
call's task id, in the same commit as the change. A replayed call returns the stored result and creates nothing. The
last 256 results are kept. `spawn_agent` also skips `initialContext` on a replay. `stop_agent` is `replay: 'unsafe'`:
rerunning it after a crash could stop newer work.

The tests in `test/agents/agents.test.ts` close and reopen, and SIGKILL and reopen, with a delivery in flight, and
check that each message and report appears exactly once.

## Settings and tools on each launch

An agent copies Pi's stored choices: model, thinking level, extensions, tools, model tools, cwd and instructions
(`deriveAgent`). This happens at spawn and again at every work launch:

```js
await root.configure(agent, context);                 // this launch's choices for Pi
await syncAgents(harness, context, { childAgent });   // re-derive every agent from Pi
```

So an agent follows the current launch: `--model`, `--thinking`, `--cwd` and `--allow-tools`. An agent spawned under
`--allow-tools` loses the coding tools on the next launch without it. The terminal UI's `/model` and `/tools` take the
same two steps mid-launch (`Instance.setModel`, `Instance.setTools`), so agents follow them from their next request.

After copying, `deriveAgent` applies the role offer (subs lose `spawn_agent` and `stop_agent`), then the host's
`childAgent` change:

```js
const childAgent = { extensions: { remove: [Unii] } };
```

This removes the `uniichat` extension, with its `zoom` and `date` tools, its system section and its request rewrite.
An agent sees its own conversation, not a view. Its tools are the five agent tools (three for a sub), plus `read`,
`write`, `edit` and `bash` when the launch has `--allow-tools`. See [ADR 0003](decisions/0003-memory-only-for-pi.md).

## Reading an agent's chat

Pi's `zoom("Name")` returns `agentTranscript(harness, name)`: the agent's whole conversation, oldest first:

```
> [from Pi] Plan the work.
  spawn_agent({"name":"B","task":"Do part B."})
  → Started sub agent B. Its report will arrive as a message starting with [B].
Lead: Delegated to A and B.
```

User messages start with `> `, replies with `Name: `, tool calls are indented, and each tool result is cut to 500
characters. `zoom("Pi")` gives Pi's own transcript. An unknown name is an error (`No agent named X`).

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
- **Every run reports.** A main agent that is woken again (by a sub's report or a message) reports again at the end
  of that run. In the restart test, M reports `M waiting`, then `M relays: S finished`.
- **Failures report, stops do not.** A run that ends unanswered reports `[Name] failed: <reason>`; an aborted run
  reports nothing.
- **No pi-durable compaction for agents either.** The host passes `settings: { compaction: { enabled: false } }` to
  the Harness, and pi-durable shares settings across every conversation. Agents have no UniiChat memory either, so nothing
  bounds a long agent conversation: it grows until it reaches the model's context window.
- **Agents never see Pi's later view.** The view is only in an agent's first input. Later, it can ask Pi
  (`send_message("Pi", …)`, mains only) or read `last_message("Pi")`.
- **`onReport` is not used by the host.** The extension accepts an `onReport` callback, but the host does not pass
  one. Pi's memory logs a report when Pi's next request sees its `agents.report` entry.
