# Memory

Pi's context is not its transcript. It is a fixed-size **view** of a summary tree built over a log of every message.
This is UniiChat, following Victor Taelin's recipe
([*UniiChat: one chat that never ends*](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)).
The recipe has no license, so it is linked here and not copied. Section numbers below (§1–§7) refer to it.

The code is in `src/memory/`. The pi-durable extension it installs is named `uniichat`. It applies to the root
conversation (Pi) only; spawned agents do not get it (see [agents.md](agents.md) and
[ADR 0003](decisions/0003-memory-only-for-pi.md)).

pi-durable still stores the full transcript in SQLite (`--history` prints it). The memory is a second, separate
record that decides what the model sees.

## Contents

- [The log](#the-log)
- [The tree](#the-tree)
- [The view](#the-view)
- [The compactor](#the-compactor)
- [A turn's request](#a-turns-request)
- [Tools: zoom and date](#tools-zoom-and-date)
- [On-disk layout](#on-disk-layout)
- [Module map](#module-map)
- [Deviations from the recipe](#deviations-from-the-recipe)

## The log

The log is append-only. Each record is one JSON line in `main/YYYY-MM-DD.jsonl`:

```json
{"i": 42, "kind": "user", "text": "…", "size": 17, "date": "2026-10-19T16:54:01.000Z", "src": "e:8"}
```

| Field | Meaning |
|---|---|
| `i` | Permanent message id, starting at 0. Ids must be contiguous: on load, a gap makes `openMemory` throw (`log … is not contiguous`). |
| `kind` | One of `user`, `pi`, `tool`, `echo`, `work`, `note`. |
| `text` | The message text. |
| `size` | UTF-8 bytes of `` `${kind}: ${text}` ``. |
| `date` | ISO timestamp of when the message happened. |
| `src` | Optional idempotency key (see below). |

The file name is the local day of the write, not of `date`. Files split by day only to stay small. Each line is
fsynced before `append()` returns. Damaged lines are skipped with a warning; a line that parses but lacks one of
these fields (with its type) is dropped.

### Kinds

| Kind | Written by | Text |
|---|---|---|
| `user` | Pi's input entries (typed messages, steering) | the user's words |
| `pi` | Pi's assistant messages | the text blocks, joined by newlines; thinking is never logged |
| `tool` | each tool call in an assistant message | `` `${name} ${JSON.stringify(arguments)}` `` |
| `echo` | each tool result | `` `${toolName}: ${isError ? 'error: ' : ''}${text}` ``; image blocks become `[image]` |
| `work` | an input entry of kind `agents.report` | `[Name] text`; `append` rejects a `work` text that does not start with `[Name]` |
| `note` | nothing in this host | reserved for memories imported from before the chat |

Assistant messages are logged only when their `stopReason` is `stop`, `length` or `toolUse`. Errors and aborts are
not logged. Empty or whitespace-only text logs nothing.

### Clipping and splitting

The limit is `CAP = 30_000` characters (`src/memory/util.ts`).

- `echo` text is **clipped**: the first 15,000 and the last 15,000 characters, around a marker
  `[… N characters clipped …]` that does not count toward the limit.
- Any other text longer than `CAP` is **split** into several consecutive records, never cut. Each part ends at the
  last newline before the limit when there is one. Splitting never breaks a surrogate pair.

### Idempotency via `src`

pi-durable replays runs after a restart, and the extension catches up on messages it has not logged yet. So every
append carries a `src` key, and a second append with a known `src` logs nothing, also after a restart (the keys are
rebuilt from the log on open).

| Source | `src` |
|---|---|
| user input with a committed entry | `e:<entryId>` (`e:<entryId>:<n>` for its n-th message) |
| user input without one | `u:<timestamp>:<hash(text)>` |
| agent report | `report:<id>`, where `id` is the delivery task id from `data.id`; without an id, `report:<hash(name + "\n" + text)>` |
| assistant message | `a:<timestamp>:<hash(text)>` |
| tool call | `c:<toolCallId>` |
| tool result | `r:<toolCallId>` |
| split part n > 0 | `<src>#<n>` |

`hash` is the first 16 hex digits of SHA-256.

## The tree

```
node(0, i) = message i, in at most 512 bytes
node(l, i) = node(l-1, 2i) and node(l-1, 2i+1) merged, in at most 512 bytes
```

`NODE = 512` bytes. `node(l, i)` covers the `2^l` messages from `i·2^l` on and is named `id+n`: its first message
and how many it covers. `node(3, 5)` is `40+8`.

- A leaf whose source `` `${kind}: ${text}` `` fits in 512 bytes is its own node, with no model call.
- A parent whose two children, joined by a newline, fit in 512 bytes is built at once, with no model call.
- Every other node is one compaction (see [The compactor](#the-compactor)).
- Each node is built once, appended to `tree/YYYY-MM-DD.jsonl` as `{l, i, text, size}`, and never rebuilt.

On load, a tree record that covers messages past the end of the log is ignored.

## The view

The view is a list of nodes that tiles messages `[0, T)`, oldest first. It is rendered as:

```
<chat>
0+1024|…
1024+512|…
9627+1|…
</chat>
```

One line per node, with newlines turned into spaces. A node not built yet renders as
`id+n|(not summarized yet: zoom it)`. A line costs its UTF-8 bytes plus one for the newline.

### When it merges: the sawtooth

Budget `VIEW = { hi: 128_000, lo: 64_000 }` bytes.

- Each new message appends its line. Nothing else changes.
- Once the view passes 128,000 bytes, one batch merges pairs until it is at most 64,000 bytes.

So between batches the previous view is a byte prefix of the next one, and provider prompt caches keep working.

### Which pair merges: due

For sibling lines `(l, i)` and `(l, i+1)` with `T` messages in the log:

```
due = (T - last) / 2^l          last: the pair's last message
```

The batch merges the most due pair, the oldest on ties, and repeats. With every parent built, this order equals
Taelin's rollback `push` at every step (`test/memory/view.test.ts` checks t = 0..5000).

A batch merges only a pair whose parent node is built. If the most due pair's parent is not built yet, the batch
**waits** for it instead of merging a less due pair. The view may stay over 128 KB until the summary lands. Past twice
`hi` (256,000 bytes), for example when one node keeps failing, it falls back to the most due pair whose parent is
built. See [deviation 5](#deviations-from-the-recipe).

### view.json is saved, never rebuilt

The view is saved to `view.json` after every change (temporary file, fsync, rename):

```json
{"view": [[l, i], …], "cview": [[l, i], …], "shrinking": [false, false]}
```

`cview` is the compaction view (below); `shrinking` records a batch in progress for each. On open the saved view is
loaded as is. It is never refolded from the log, even if the budget changed, because a refolded view differs from the
live one and every cache entry would die.

Two cases are handled:

- **The log is ahead of `view.json`** (a crash between the log write and the save): the missing messages are appended
  as they would have been.
- **`view.json` is missing or does not tile the log**: a warning is printed and the log is folded once, from scratch.
  This is also how the first open works.

## The compactor

The compactor builds the tree in the background, in the host process that owns the memory.

### Scheduling

| Constant | Value | Meaning |
|---|---|---|
| `JOBS` | 8 | compaction calls in flight at once (the host passes 2 when the compaction model is `claude-cli`) |
| `LEAD` | 8 | a leaf starts once fewer than 8 leaves before it are unbuilt |

Work comes from ready queues; the tree is never scanned:

- `instant`: parents whose joined children fit in 512 bytes (built without a call).
- leaves, in message order from the first unbuilt one.
- `retryLeaves`: leaves whose call failed.
- `merges`: a heap of parents whose two halves are built, oldest start first, then lower level.

A parent is queued exactly when its second child is built. A failed call keeps its node out of the queues until a
retry: at the next appended message, or after `retryMs` (10 s), whichever comes first. The last error is kept for
`/status`.

### The compaction call

A compaction is a call like a turn. It sends:

```
[system prompt] [tools] [user: <chat> compaction view </chat> + task]
```

- **System prompt and tools** are those of the latest turn (`setCompactionPrompt`, set on each Pi request), so
  compactions share the turns' cached prefix. Tools are sent with `toolChoice: "none"`. Before the first turn of a
  process, the compactor uses the recipe prompt alone, with no tools.
- **The compaction view** is a second sawtooth view with budget `COMPACTION_VIEW = { hi: 32_000, lo: 16_000 }`. When
  the chat view runs a batch, the compaction view is reset to a copy of it and merged down to 16 KB; otherwise it gets
  the same new lines and runs its own batches past 32 KB. For a leaf it holds the built lines before the message; for
  a merge, the built lines up to the merge's last message. It stops at the first unbuilt line, so a compaction never
  sees a placeholder.
- **The task** is the recipe's text (`leafTask`, `mergeTask` in `src/memory/prompt.ts`), with a ruler of 512 dashes
  that shows the length.

### The size cut

Models cannot count bytes. The harness enforces the limit:

1. The reply is cleaned to one line: code fences and an echoed `id+n|` head are stripped, newlines become spaces.
2. If it is over 512 bytes, the compactor sends the recipe's "Too long" message in the same conversation, once
   (`tooLongRetries = 1`), and keeps the shorter of the two replies. A failed retry also keeps the first reply.
3. If the kept line is still over 512 bytes, `cutLine` cuts it: at the last `; ` or sentence end past half the limit,
   else at the last comma past half the limit, else at the byte limit. It never splits a character.

An empty reply is a failed call. See [ADR 0007](decisions/0007-cheap-compaction-model.md).

### The model

`defaultCompactionModel(turnModel, models)` in `src/memory/summarizer.ts` picks the compaction model:

| Turn provider | Compaction model |
|---|---|
| `openai-codex` | `openai-codex/gpt-6-luna`, if the catalog has it |
| `openai` | `openai/gpt-6-luna`, if the catalog has it |
| `claude-cli` | `claude-cli/haiku` (Claude Haiku 5.5 through the `claude` CLI) |
| `anthropic` | `anthropic/claude-haiku-5-5`, if the catalog has it |
| any other | the turn model itself |

The turn model comes from `--model PROVIDER/ID`, else `PI_DURABLE_MODEL`, else `openai-codex/gpt-6.1-sol`. So the
default compaction model is `openai-codex/gpt-6-luna`. A source comment gives the reason: in the pinned pi-ai 1.3.0
catalog it costs $0.10/$0.50 per million tokens (cache read $0.01), against $2/$10 for `gpt-6.1-sol`, with the same
272k window.

With `claude-cli`, every compaction is a full `claude` call that draws on the plan's usage limits, so the host opens the
memory with `jobs: 2` (`src/runtime/runtime.ts`). Such calls get no tools, since the compactor sends
`toolChoice: "none"`, and the CLI ignores `maxTokens`. See [models.md](models.md).

The host has no flag for the compaction model. Programmatically, `openMemory(dir, { compactionModel })` overrides
it, and `openMemory(dir, { summarize })` replaces the summarizer entirely. The default summarizer
(`createPiAiSummarizer`) makes one `completeSimple` call per request with:

- `reasoning: 'low'`, only when the model supports reasoning;
- `maxTokens` 4,000 for a reasoning model, else 400;
- a 120 s timeout;
- `sessionId: 'uniichat-compactor'`.

### Closing

`close(graceMs = 5000)` stops new work, gives calls in flight up to 5 s, aborts the rest and saves. An aborted node
is built again at the next open.

## A turn's request

The extension's `beforeRequest` hook replaces every request of a Pi run with:

```
[system]  [user: view | turn state | previous exchange | message]  + the run's steps
```

- **system**: pi-durable's system message. Its sections are, in order, `uniichat` (the recipe prompt, adapted),
  `agents` (Pi's role text) and `instructions` (the host's instructions for this launch).
- **view**: `memory.render(k)`, the view of messages `[0, k)`.
- **turn state**: `<turn>\nnow: 2026-10-19 13:54:01 -03:00 (Monday)\n</turn>`. Dates and state never go into the
  system prompt.
- **previous exchange**: the last user or work message(s) and the `pi` reply that ends right before `k`, whole, in
  `<previous_exchange>` tags. It is omitted when message `k-1` is not a `pi` reply, or when the block would exceed
  16,000 bytes. Tool steps between them are left out.
- **message**: the run's first input, whole (a typed message, or `[Name] report` from an agent).
- **the run's steps**: the run's own assistant messages, tool results and steering messages, as pi-durable has them.
  Text blocks of tool results over 30,000 characters are clipped as in the log.

A **run** is everything after the last final assistant message. The first three user blocks are computed once per
run and frozen (keyed by the run's first input), so every request of a run shares one prefix. Up to 8 runs are kept.

**Where the view ends.** For a new run, `k` is the end of the log: the view is rendered before the run's message is
logged, so the message is not in its own view. For a run resumed after a restart, its messages may already be the
log's tail; `k` then stops before them, so the resumed run sees the same view.

**The settle wait.** Before rendering, the hook waits until every line before `k` is built, at most `settleMs`
(8,000 ms) or until the request is aborted. After that it renders whatever is built, with placeholders for the rest.
The model can `zoom` a placeholder line to read the message whole. The last reply is in the previous exchange anyway.

**Logging.** In the same hook, everything since the last final answer that is not logged yet is appended (inputs,
replies, tool calls, results). `afterResponse` logs each assistant message as it lands, and `afterTool` each tool
result. The `src` keys make the overlap harmless.

pi-durable's own compaction of the root is declined (`beforeCompact` returns `{ decline: true }`), and the host also
sets `settings.compaction.enabled: false`. See [ADR 0002](decisions/0002-uniichat-memory.md).

## Tools: zoom and date

Both tools are `replay: 'safe'` and always on for Pi.

### zoom

```
zoom(id, n = 1, page = 1)
zoom("Name")
```

- `zoom(id, n)` with `n > 1` opens line `id+n` into its two halves, as two view lines. `n` must be a power of 2, `id`
  a multiple of `n`, and `id + n` at most `T`. An unbuilt half shows as `id+n|(not summarized yet: zoom(id, n))`.
  Any node can be opened, not only lines in the current view.
- `zoom(id, 1)` gives message `id` whole as `id+1|kind: text`. A message over 16,000 characters (`PAGE`) comes in
  pages: `id+1 (page p of P; zoom(id, 1, page) for the others)|…`. A message that was split at 30,000 characters is
  several ids; each `zoom(id, 1)` gives one part.
- `zoom("Name")` gives an agent's whole chat, from `agentTranscript` in `src/agents/index.ts`. A string of digits is
  read as an id; square brackets around a name are stripped. `zoom("Pi")` gives Pi's own transcript.

The tool's output is limited to 256 KiB and 100,000 lines.

### date

`date(id)` returns the time of message `id` in the host's local zone, for example
`2026-01-03 12:00:00 -03:00 (Saturday)`.

## On-disk layout

The memory directory sits beside the database: the database path with `.sqlite` replaced by `.unii` (or `.unii`
appended when the path has no `.sqlite` suffix). For the default global chat:

```
~/.local/state/pi-durable/        ($PI_DURABLE_DATA_DIR, or $XDG_STATE_HOME/pi-durable)
├── chat.sqlite                    pi-durable's database (full transcript, tasks, agents registry)
├── chat.sqlite.lock               flock held by the host for its whole life
└── chat.unii/
    ├── main/YYYY-MM-DD.jsonl      the log: {i, kind, text, size, date, src?}
    ├── tree/YYYY-MM-DD.jsonl      the tree: {l, i, text, size}
    └── view.json                  {view, cview, shrinking}
```

Directories are created with mode 0700 and files with 0600. `view.json.<pid>.tmp` exists briefly during a save.
`--status` and `--history` do not open the memory directory. The lock is described in
[ADR 0008](decisions/0008-one-writer.md).

## Module map

| File | Contents |
|---|---|
| `src/memory/index.ts` | Public exports: `openMemory`, `Memory`, `KINDS`, `isKind`, `createUniiExtension`, `REPORT_KIND`, `createPiAiSummarizer`, `defaultCompactionModel`, `PROMPT`, and their types (`Kind`, `MemoryRecord`, `MemoryOptions`, `Summarizer`, `UniiExtensionOptions`, …). |
| `src/memory/memory.ts` | `Memory`: the log, the tree, both views, the compactor queues, `render`, `settle`, `zoom`, `date`, `previousExchange`, `status`; `openMemory` and its one-open-per-process guard. |
| `src/memory/view.ts` | `View`: the sawtooth `fit` and the `due` order; node helpers `start`, `end`, `key`, `name`, `parentOf`; `cut` for a view ending before message k. |
| `src/memory/prompt.ts` | The system prompt `PROMPT`, the compaction tasks `leafTask` and `mergeTask`, `tooLong`, the 512-dash `RULER`, the placeholder text. |
| `src/memory/summarizer.ts` | The default pi-ai summarizer and the compaction model choice (`CHEAP_MODELS`, `defaultCompactionModel`). |
| `src/memory/extension.ts` | The `uniichat` pi-durable extension: the request rewrite, the logging hooks, the `zoom` and `date` tools, the declined compactions. |
| `src/memory/util.ts` | `NODE`, `CAP`, `clip`, `split`, `cutLine`, `cleanLine`, byte helpers, date formatting, `appendJson`, `atomicWrite`, `errorMessage`, `isObject`. |

## Deviations from the recipe

Each item names what the recipe says, what this code does, and why. Items 1–5 follow pi-endless's documented
deviations (its numbers are given); the rest are specific to this host.

1. **One "Too long" retry, then a cut.** The recipe retries up to 5 times and keeps the shortest line. Here there is
   one retry (`tooLongRetries = 1`), then `cutLine` enforces 512 bytes. pi-endless measured cheap models returning the
   same over-long line on every retry (its deviation #1, which uses no retry at all). One retry keeps the model's own
   shortening when it works; the cut makes the limit hold regardless.
2. **A cheap OpenAI model as compactor.** The recipe uses Claude Haiku at xhigh effort. This host's default provider
   is `openai-codex`, so the compactor is `gpt-6-luna` at `reasoning: 'low'`, the cheapest model of that provider in the
   pinned catalog. With `claude-cli` or `anthropic` it is Haiku 5.5, the recipe's family, at low effort; with
   `claude-cli` at most 2 run at once. Another provider gets its turn model. See
   [ADR 0007](decisions/0007-cheap-compaction-model.md) and [ADR 0010](decisions/0010-claude-via-cli.md).
3. **The previous exchange is sent whole** after the view, up to 16,000 bytes (pi-endless #3). Follow-up questions such
   as "why?" work without a zoom, and the view prefix is unchanged.
4. **Turns wait at most 8 s** for pending summaries, then render placeholders (pi-endless #4). The recipe waits until
   every message is summarized; a slow or failing compactor would block every turn.
5. **A batch waits for the most due pair** (pi-endless #9). The recipe merges the most due pair whose parent is built.
   When the compactor lags, that rule merges the newest lines first and the recent stretch turns coarse for good.
   Here the batch waits, and past twice the budget falls back to the recipe's rule. With all parents built the order
   is the same (the push test still passes).
6. **Idempotency keys (`src`) on log records.** The recipe's record has no such field. pi-durable replays runs and
   tool calls after a crash, and the extension logs from several hooks, so each append is keyed to log once.
7. **A failed compaction is also retried on a timer** (10 s), not only at the next message. A quiet chat would
   otherwise keep a placeholder until the user writes again.
8. **The prompt is the recipe's, renamed.** "Unii" becomes "Pi", the reply kind `unii` becomes `pi`, and the paragraph
   on the user's computers is dropped (this host has no device tools). Nothing else changes. The prompt says that
   `zoom(id, 1)` gives a message "with its images", but the log stores text only; images appear as `[image]`.
9. **No cache marks.** The recipe places Anthropic cache marks every 4 view lines. This host places none of its own.
   It relies on the stable prefix (constant system prompt and tools, a view that grows at its end) and on the
   provider's own prefix caching, with pi-durable's per-conversation `sessionId`.
10. **Persistent agents instead of fresh subagent calls.** In the recipe a subagent is a fresh call whose first message
    is the view. Here an agent is a persistent pi-durable conversation. Its first input starts with the view rendered
    at spawn time, then `[from Name] task`; later inputs carry no view, and the agent has no memory of its own. A
    main agent's `send_message` to Pi is logged as a `work` message like a final report. See [agents.md](agents.md).
11. **One writer through the host's flock.** The recipe asks for a lock on the chat. Here the memory directory is
    derived from the database path, and the flock the launcher takes on `<database>.lock` covers both. See
    [ADR 0008](decisions/0008-one-writer.md).
12. **Nothing is imported.** The `note` kind exists, but no import is implemented, including from this host's older
    per-project databases. See [ADR 0001](decisions/0001-one-global-chat.md).

Where pi-endless deviates but this code follows the recipe: there is no `search` tool (zoom is the only way into the
tree, as the prompt says), and compactions share the turns' system prompt and tools.
