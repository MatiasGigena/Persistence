# Memory

Pi's context is not its transcript. It is a fixed-size **view** of a summary tree built over a log of every message.
This is UniiChat. It was first built from Victor Taelin's recipe
([*UniiChat: one chat that never ends*](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449);
section numbers §1–§7 in the code refer to it). The recipe is now superseded by UniiChat's published source,
[github.com/VictorTaelin/uniichat](https://github.com/VictorTaelin/uniichat) (Apache-2.0), mainly
[`Memory.ts`](https://github.com/VictorTaelin/uniichat/blob/main/Memory.ts) and [`prompt.txt`](https://github.com/VictorTaelin/uniichat/blob/main/prompt.txt). This code follows that source
where the two differ, except for the deviations listed at the end. The system prompt, the compaction tasks and the
"Too long" note are adapted from it; see [NOTICE](../NOTICE).

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
- [Deviations from UniiChat](#deviations-from-uniichat)

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
fsynced before `append()` returns; the parts of a split text go in one write. Damaged lines are skipped with a
warning; a line that parses but lacks one of these fields (with its type) is dropped. Text is made well-formed first
(`toWellFormed`: a lone surrogate becomes U+FFFD), as upstream does.

### Kinds

| Kind | Written by | Text |
|---|---|---|
| `user` | Pi's input entries (typed messages, steering) | the user's words |
| `pi` | Pi's assistant messages | the text blocks, joined by newlines; thinking is never logged |
| `tool` | each tool call in an assistant message | `` `${name} ${JSON.stringify(arguments)}` `` |
| `echo` | each tool result | `` `${toolName}: ${isError ? 'error: ' : ''}${text}` ``; image blocks become `[image]` |
| `work` | an input entry of kind `agents.report`, or `memory.report()` | as Pi sees the report: `[Name]\ntext\n\nFull chat: zoom("Name")`, or `zoom("Name#n")` with the entry's `data.session` (a standing agent's session) (upstream `report_text`); `append` rejects a `work` text that does not start with `[Name]` |
| `note` | nothing in this host | reserved for memories imported from before the chat |

Each `tool` record comes right before its `echo` (call, result, call, result), as upstream logs a call with its
result. An assistant message cut off by an error or an abort is logged by the next run, as its text followed by
`\n[cut off: why]` (`stopped` for an abort, else the error message, at most 300 characters), as upstream's
`Agent.fail` does. Empty or whitespace-only text logs nothing.

### Clipping and splitting

The limit is `CAP = 30_000` characters (`src/memory/util.ts`).

- `echo` text is **clipped**: the first 14,936 and the last 14,936 characters, around a marker
  `[… N characters clipped …]`, so the whole is at most 30,000 characters (upstream `Clip.ts` keeps 64 characters per
  half for the marker). Records logged by older versions may be up to about 40 characters over.
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
- A parent's source is its two children's texts, each flat, joined by a newline. If it fits in 512 bytes it is the
  node, built at once with no model call.
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

One line per node, made flat: each newline and the whitespace around it become one space (upstream `flat`). A node
not built yet renders as `id+n|(not summarized yet: zoom it)`. A line costs its UTF-8 bytes, `id+n|` head included,
plus one for the newline.

### When it merges: the sawtooth

Budget `VIEW = { hi: 128_000, lo: 64_000 }` bytes.

- Each new message appends its line. Nothing else changes.
- Once the view passes 128,000 bytes, one batch merges pairs until it is at most 64,000 bytes.
- Between messages (when a node is built) a batch lands only whole: down to 64,000 bytes, or by at least 128,000
  bytes. At a message, a batch still under way keeps what it could merge and goes on at the next message (upstream
  `Memory.fit`).

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
built. See [deviation 5](#deviations-from-uniichat).

### view.json is saved, never rebuilt

The view is saved to `view.json` after every change (temporary file, fsync, rename):

```json
{"view": [[l, i], …], "cview": [[l, i], …], "shrinking": [false, false]}
```

`cview` is the compaction view (below); `shrinking` records a batch in progress for each. On open the saved view is
loaded as is. It is never refolded from the log, even if the budget changed, because a refolded view differs from the
live one and every cache entry would die.

Three cases are handled:

- **The log is ahead of `view.json`** (a crash between the log write and the save): the missing messages are appended
  as they would have been.
- **A saved line's node is missing** (a tree line lost in a crash): it opens into its halves, down to built nodes or
  messages, as upstream's `Memory.open` does. The rest of the view stays as saved.
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

- `instant`: parents whose source fits in 512 bytes (built without a call).
- `retryLeaves`: leaves whose call failed, first.
- leaves, in message order from the first unbuilt one, and `merges`, a heap of parents whose two halves are built.
  The two go in the order the messages came, as upstream's `Memory.starts`: a node by the end of its context (a
  leaf's message, a merge's last message plus one), a merge before a leaf at a tie. A leaf that fits takes no call
  slot, so it never waits for one.

A parent is queued exactly when its second child is built. A failed call keeps its node out of the queues until a
retry: at the next appended message, or after `retryMs` (10 s), whichever comes first. The last error is kept for
`/status`.

### The compaction call

A compaction is a call like a turn. It sends:

```
[system prompt] [user: <chat> compaction view </chat> + task]
```

- **The system prompt** is the latest turn's (`setCompactionPrompt`, set on each Pi request), and no tools, as
  upstream: the compaction model usually differs from the turn model, so tools would buy no shared cache. Before the
  first turn of a process, the compactor uses `PROMPT` alone.
- **The compaction view** is a second sawtooth view with budget `COMPACTION_VIEW = { hi: 32_000, lo: 16_000 }`. It
  gets every new line and runs its own batches, independent of the chat view (upstream: "two, each on its own"; the
  recipe reset it from the chat view at each chat batch). For a leaf it holds the built lines before the message; for
  a merge, the built lines up to the merge's last message. It stops at the first unbuilt line, so a compaction never
  sees a placeholder.
- **The task** is upstream's `LEAF` or `MERGE` text (`leafTask`, `mergeTask` in `src/memory/prompt.ts`), with a
  ruler of 512 dashes that shows the length. A merge's `<input>` is its source: the two halves' flat texts, without
  `id+n|` heads.

### The size cut

Models cannot count bytes. The harness enforces the limit:

1. The reply is cleaned to one line: code fences and an echoed `id+n|` head are stripped, newlines become spaces.
2. If it is over 512 bytes, the compactor asks once more (`tooLongRetries = 1`): a fresh call with the same view and
   task, plus upstream's note `Too long: your last line for this <input> was N bytes, …` and the line's first 512
   bytes before `| ← LIMIT`. The long line itself is never sent back as an assistant turn. The shorter of the two
   replies is kept; a failed or empty retry keeps the first.
3. If the kept line is still over 512 bytes, `cutLine` cuts it: at the last `; ` or sentence end past half the limit,
   else at the last comma past half the limit, else at the byte limit. It never splits a character.

**No line.** When the model answers without a line, asking again would fail alike, so the node becomes its source,
flat, cut to its first 512 bytes, with a warning (upstream `Memory.build`). That covers an empty reply and a
`CompactionRefused` from the summarizer, which the default summarizer throws for Anthropic's `refusal` and
`sensitive` stop reasons. Any other error (network, rate limit, timeout) is an outage: the node stays unbuilt and is
retried. See [ADR 0007](decisions/0007-cheap-compaction-model.md).

### The model

`defaultCompactionModel(turnModel, models)` in `src/memory/summarizer.ts` picks the compaction model:

| Turn provider | Compaction model |
|---|---|
| `openai-codex` | `openai-codex/gpt-6-luna`, if the catalog has it |
| `openai` | `openai/gpt-6-luna`, if the catalog has it |
| `claude-cli` | `claude-cli/haiku` (Claude Haiku 5.5 through the `claude` CLI) |
| `anthropic` | `anthropic/claude-haiku-5-5`, if the catalog has it |
| any other | the turn model itself |

The turn model comes from `--model PROVIDER/ID`, else `PI_DURABLE_MODEL`, else the model last chosen with `/model`
(`settings.json`), else `openai-codex/gpt-6.1-sol`. So the default compaction model is `openai-codex/gpt-6-luna`. A source comment gives the reason: in the pinned pi-ai 1.5.0
catalog it costs $0.10/$0.50 per million tokens (cache read $0.01), against $2/$10 for `gpt-6.1-sol`, with the same
272k window.

With `claude-cli`, every compaction is a full `claude` call that draws on the plan's usage limits, so the host opens the
memory with `jobs: 2` (`src/runtime/runtime.ts`). Such calls get no tools, and the CLI ignores `maxTokens`. See [models.md](models.md).

A `/model` switch moves the compaction model with the turn model: the host builds a new default summarizer for the
new provider's compaction model and calls `memory.setSummarizer(summarize, jobs)` (2 jobs for `claude-cli`, else 8).
Each node is built by the summarizer it started with, its "Too long" retry included, so calls in flight finish on
the old model; lowering `jobs` only holds back new calls until enough have finished.

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
- **turn state**: `<turn>\nnow: 2026-10-19 13:54:01 -03:00 (Monday)\n</turn>`, plus a line
  `agents at work: A, B` (or `none`) when the host passes `atWork()`. Dates and state never go into the system
  prompt.
- **previous exchange**: the last user or work message(s) and the `pi` reply that ends right before `k`, whole, in
  `<previous_exchange>` tags. It is omitted when message `k-1` is not a `pi` reply, or when the block would exceed
  16,000 bytes. Tool steps between them are left out.
- **message**: the run's first input (a typed message, or an agent's report), after upstream's head `TURN_HEAD` =
  `Turn: the user's new message:` and a blank line. It goes whole, unless its parts do not fit in the view's `hi`
  (128,000 bytes): then `k = memory.firstWhole(from)` and the message is only `memory.joinedText(k, end)`, its last parts; the
  first ones are in the view, summarized. Steering messages are not headed and go whole.
- **the run's steps**: the run's own assistant messages, tool results and steering messages, as pi-durable has them.
  Text blocks of tool results over 30,000 characters are clipped as in the log.

A **run** starts at the first user message after the last final answer, or after the last reply written by another
generation task, so a failed or stopped run is never sent again; its unlogged tail is logged before the view renders.
The first three user blocks and the message's tail are computed once per run and frozen (keyed by the run's first
input), so every request of a run shares one prefix. Up to 8 runs are kept.

**Where the view ends.** The run's input is logged first (as upstream logs a message on arrival), so `whole` can
measure it. The view still never holds the run's own message: `from` walks back from the end of the log over the
run's own records (the input just logged, or after a restart its later steps too), and the view ends at `k = from`,
or later inside a huge paste. A resumed run so sees the same view. When later records of a resumed run make
`whole` count past the input, `k` is clamped so the input's last part still goes whole.

**The settle wait.** Before rendering, the hook waits until every line before `k` is built, at most `settleMs`
(8,000 ms) or until the request is aborted. After that it renders whatever is built, with placeholders for the rest.
The model can `zoom` a placeholder line to read the message whole. The last reply is in the previous exchange anyway
(which is empty when `k` falls inside a paste).

**Logging.** In the same hook, everything since the last final answer that is not logged yet is appended (inputs,
replies, tool calls, results). `afterResponse` logs each assistant message as it lands, and `afterTool` each tool
result. The `src` keys make the overlap harmless.

pi-durable's own compaction of the root is declined (`beforeCompact` returns `{ decline: true }`). The host leaves
`settings.compaction` on, so pi-durable compacts agents, which have no view. See
[ADR 0002](decisions/0002-uniichat-memory.md) and [ADR 0015](decisions/0015-agent-compaction.md).

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
- `zoom(id, 1)` gives message `id` whole as `id+1|kind: text`. Pages are 30,000 characters (`PAGE = CAP`), split
  at a newline when there is one, so any message logged now is one page; an older clipped `echo` slightly over the
  limit comes in two: `id+1 (page p of P; zoom(id, 1, page) for the others)|kind: …`. A text that was split at
  30,000 characters is several ids; each `zoom(id, 1)` gives one part.
- Bad arguments are an error that names the tree's roots (a node per power of two in `T`, largest first), where any
  zoom can start, as upstream's `zoom` does: `No line 0+16: …. The tree's roots: 0+8, 8+2.`
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
| `src/memory/index.ts` | Public exports: `openMemory`, `Memory`, `KINDS`, `isKind`, `createUniiExtension`, `REPORT_KIND`, `createPiAiSummarizer`, `CompactionRefused`, `defaultCompactionModel`, `PROMPT`, and their types (`Kind`, `MemoryRecord`, `MemoryOptions`, `Summarizer`, `UniiExtensionOptions`, …). |
| `src/memory/memory.ts` | `Memory`: the log, the tree, both views, the compactor queues, `render`, `settle`, `whole`, `say`, `zoom`, `date`, `previousExchange`, `status`; `openMemory` and its one-open-per-process guard. |
| `src/memory/view.ts` | `View`: the sawtooth `fit` and the `due` order; node helpers `start`, `end`, `key`, `name`, `parentOf`; `cut` for a view ending before message k. |
| `src/memory/prompt.ts` | The system prompt `PROMPT`, the compaction tasks `leafTask` and `mergeTask`, `tooLong`, the 512-dash `RULER`, the placeholder text; adapted from upstream's `prompt.txt` and `Memory.ts`. |
| `src/memory/summarizer.ts` | The default pi-ai summarizer, `CompactionRefused` (an answer with no line), and the compaction model choice (`CHEAP_MODELS`, `defaultCompactionModel`). |
| `src/memory/extension.ts` | The `uniichat` pi-durable extension: the request rewrite, the logging hooks, the `zoom` and `date` tools, the declined compactions. |
| `src/memory/util.ts` | `NODE`, `CAP`, `clip`, `split`, `cutLine`, `cleanLine`, byte helpers, date formatting, `appendJson`, `atomicWrite`, `errorMessage`, `isObject`. |

## Deviations from UniiChat

Checked against UniiChat's source ([`Memory.ts`](https://github.com/VictorTaelin/uniichat/blob/main/Memory.ts), [`prompt.txt`](https://github.com/VictorTaelin/uniichat/blob/main/prompt.txt),
[`Clip.ts`](https://github.com/VictorTaelin/uniichat/blob/main/Clip.ts), [`AskAI.ts`](https://github.com/VictorTaelin/uniichat/blob/main/AskAI.ts), [`Server.ts`](https://github.com/VictorTaelin/uniichat/blob/main/Server.ts)), which supersedes the gist. Each
item says what upstream does, what this code does, and why. Numbers 3 and 5 are cited from the code; keep them.
Upstream's hosting, billing, devices, computer use, iOS app and chat imports are out of scope and not listed.

1. **One "Too long" retry, then a cut.** Upstream's `build` asks up to `TRIES = 5` times, each a fresh call of the
   task plus a note on the last line, keeps the shortest, and stores it even if it is still over 512 bytes. Here the
   retry has the same shape, but there is one (`tooLongRetries = 1`), and `cutLine` then enforces 512 bytes.
   pi-endless measured cheap low-effort models repeating the same long line; each retry is a full call; and the cut
   keeps every line within the size the view's budget assumes. See [ADR 0007](decisions/0007-cheap-compaction-model.md).
2. **A cheap model per provider as compactor.** Upstream has one `COMPACTOR` for every chat
   ([`Config.ts`](https://github.com/VictorTaelin/uniichat/blob/main/Config.ts), default Claude Haiku 5.5 at high effort, through the API). Here the compactor follows
   the turn provider: `gpt-6-luna` for `openai-codex` and `openai`, Haiku 5.5 for `claude-cli` and `anthropic`, all at
   `reasoning: 'low'`; another provider gets its turn model. The host has no API account of its own, only the user's
   logins. See [ADR 0007](decisions/0007-cheap-compaction-model.md) and [ADR 0010](decisions/0010-claude-via-cli.md).
3. **The previous exchange is sent whole** after the view, up to 16,000 bytes. Upstream sends whole only the
   messages the turn answers (`Memory.whole`, from the first waiting one) and leaves earlier ones to the view and to
   `zoom`. Follow-up questions such as "why?" work here without a zoom, and the view prefix is unchanged. Upstream
   also sends a huge new message whole only in its last 128 KB (`whole`), its first parts going to the view; the
   extension does the same with `Memory.firstWhole(from)` and `Memory.joinedText(k, end)` for a run's first input (steering
   messages still go whole).
4. **Turns wait at most 8 s** for pending summaries, then render placeholders. Upstream's `settle` waits with no limit
   and its turn view leaves unbuilt lines out. Upstream can afford that: its calls go to an API account it bills,
   ask again every minute through an outage, and a side held for credit tells the waiting turn at once. Here the
   compactor runs on the user's subscription or login, which can be rate-limited for hours or signed out, and
   nothing reports that as a hold, so an unbounded wait would block every turn. A placeholder keeps the view tiling
   the log, and `zoom` reads the message behind it.
5. **A batch waits for the most due pair.** Upstream's `merge` takes the most due pairs whose parent is built and
   skips the others. Here the batch stops at the most due pair whose parent is not built yet and goes on once it is;
   past twice the budget it falls back to upstream's rule. Skipping makes older lines coarser than Taelin's push
   would, and this compactor lags more often (8 calls at once, not 64, on a cheap model). With all parents built the
   order is the same (the push test passes). Like upstream, between messages a batch lands only whole.
6. **Idempotency keys (`src`) on log records.** Upstream's records have none (its act log, `act`/`ans`, serves its
   server actions). pi-durable replays runs and tool calls after a crash, and the extension logs from several hooks,
   so each append is keyed to log once.
7. **A failed compaction is retried at the next message, or after 10 s.** Upstream's patient calls ask again every
   60 s (`AGAIN` in `AskAI.ts`). Both clip a node only when the model answered without a line (see
   [The size cut](#the-size-cut)). One local chat issues at most 8 calls per retry, so a shorter wait costs little.
8. **The prompt is upstream's, adapted.** "Unii" becomes "Pi" and the reply kind `unii` becomes `pi`. Dropped: the
   `ai` kind (imported chats), the paragraph on the user's computers (no device tools), and "with its images" after
   `zoom(id, 1)`. Upstream stores each image under `docs/images/` and gives it back on a zoom; this log stores text
   only, and an image block is logged as `[image]`. Images come from tool results on files Pi can read again, or
   from the user's message (pasted in the web app, ADR 0031): those go to the model with the run's message only,
   also when a huge message goes as its tail.
9. **No cache marks.** Upstream's `view` sends the view in blocks of `BLOCK = 4` lines and marks the last whole block
   for Anthropic's cache. Through pi-ai 1.5.0 that is impossible: `TextContent` has no cache field, and its Anthropic
   adapter places the breakpoints itself (system prompt, last tool, last user block). So on the Anthropic API each
   run's first request writes its view anew, while OpenAI and Codex prefix caching reuse it: the prefix is stable
   (constant system prompt and tools, a view that grows at its end), with pi-durable's per-conversation `sessionId`.
10. **Persistent agents instead of fresh subagent calls.** Upstream's subagent keeps its own log
    (`docs/agent/<Name>.jsonl`) and gets the view and that log on each call. Here an agent is a persistent pi-durable
    conversation. Its first input starts with the view rendered at spawn time, then `[from Name] task`; later inputs
    carry no view, and the agent has no memory of its own. A main agent's `send_message` to Pi is logged as a `work`
    message like a final report. See [agents.md](agents.md).
11. **One writer through the host's flock.** Upstream's server holds a lock on its directory. Here the memory
    directory is derived from the database path, and the flock the launcher takes on `<database>.lock` covers both.
    See [ADR 0008](decisions/0008-one-writer.md).
12. **Nothing is imported.** The `note` kind exists, but there is no import, so records have no `imported` or `line`
    field and the prompt has no `ai` kind. See [ADR 0001](decisions/0001-one-global-chat.md).
13. **8 calls at once, not 64.** Upstream runs `JOBS = 64` per chat and starts leaves up to the 64th unbuilt one.
    Here `JOBS = 8` (2 with `claude-cli`) and `LEAD = 8`, the recipe's numbers: compactions draw on the user's
    subscription limits. The order of work is upstream's (see [Scheduling](#scheduling)).
14. **The log is read whole into memory, with no index.** Upstream indexes each line by slot (`main.index`,
    `tree.index`), keeps only the view's nodes in memory, and marks a text's pages but the last `more` so a crash
    mid-message drops the partial message. Here every record and node is loaded at open, and the parts of a split
    text are written in one fsynced write instead. One personal chat stays small enough; revisit when the log reaches
    hundreds of megabytes.
15. **A line's size includes its `id+n|` head, its newline, and placeholders.** Upstream counts only built nodes'
    texts. This measures what a request actually carries.
16. **Small output differences.** `zoom(id, 1)` heads its text `id+1|` (upstream `id+0|`) and pages by number
    (upstream by character offset); an unbuilt half names the zoom that reads it; `date(id)` adds the UTC offset and
    the weekday; a reply is stripped of code fences and an echoed `id+n|` head (upstream trims it). A missing
    `view.json` folds the log once (upstream opens the highest built nodes), which gives the view Taelin's push would
    have.

Like upstream, there is no `search` tool (zoom is the only way into the tree, as the prompt says), and thoughts are
never logged.
