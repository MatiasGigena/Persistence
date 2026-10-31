# 0033. Code mode: one script coordinates several tool calls, each with its own protections

## Status

Accepted, 2026-10-31.

## Context

Pi Cloud (now retired) offered Code Mode: the model writes a JavaScript script that calls several tools in one tool
call (read twenty files, filter, write a summary) instead of one model round trip per call. Pi Cloud used
pi-coding-agent's `createCodemodeExtension`, built for the coding agent's session, not for pi-durable's Harness.
Persistence runs on pi-durable 1.3.0, which ships its own durable code mode (`@earendil-works/pi-durable/codemode`):
the script runs in a QuickJS VM in a worker thread (`@earendil-works/pi-codemode`), every `tools.<name>(args)` is a
nested tool call through the Harness (`api.executeTool`), and a journal replays the script after a restart.

What must not change: `/tools off` and `--no-tools` turn every file and command tool off; the coding tools act only
through the guarded environment (ADR 0025) or the run's pinned machine (machine routing); only Pi may delegate or
delete agents; credentials stay unreachable.

## Decision

- **pi-durable's durable code mode, not Pi Cloud's.** `src/tools/codemode.ts` wraps `createCodemodeExtension` with a
  `CodemodeSandbox` (worker thread, 256 MiB QuickJS heap, pi-codemode's default 5 min deadline). Names: extension
  `codemode`, tool `codemode`, and pi-durable's documents `pi.codemode.run`, `pi.codemode.journal`,
  `pi.codemode.store`; all persisted. `@earendil-works/pi-codemode` is pinned at 1.3.0 like the other packages.
- **No `models.*`** (`models: false`): scripts start no model calls, so they spend nothing and reach no provider.
- **Scripts call only `SCRIPT_TOOLS`**: `read`, `write`, `edit`, `bash`, `zoom`, `date`, `list_agents`,
  `last_message`. Where code mode is selected, every other tool the host has (agent management, `show_image`, the
  kits' browser, `web_fetch`, `autoreview`) is wrapped `callers: ['model']`, so scripts neither see nor call it, and
  the `codemode` section does not list it. A `beforeTool` guard refuses any nested call outside `SCRIPT_TOOLS` as
  well, for a tool added later and missed. `codemode` itself is model-only (pi-durable), so scripts cannot nest.
- **Each nested call is an ordinary tool call.** It resolves among the conversation's enabled tools when it runs, runs
  every `beforeTool` hook (the agents guard among them), and runs the same tool implementation the model would: the
  GuardedEnv and bubblewrap locally, the pinned machine when routed. Code mode adds no file or process access of its
  own; its large outputs go to a temp directory through the same environment.
- **On and off with the coding tools.** `codemode` is in Pi's enabled tools only while the coding tools are
  (`piTools`), `whileAllowed` refuses a call once `/tools off` lands, and the guard refuses a running script's next
  nested call at once. The `codemode` prompt section renders only while the tool is offered.
- **Agents.** Spawned agents copy Pi's tools, so they have code mode exactly when Pi has; standing agents get only
  their roster kits, and no kit names code mode.
- `instance.close()` closes the sandbox: running scripts are aborted, and the next launch replays them.

## Consequences

- A script's nested calls are not logged one by one in Pi's memory (the uniichat hook logs only top-level calls); the
  `codemode` call and its result are. The web feed and the terminal show the `codemode` call, not its nested calls.
- A restart in the middle of a script replays it; a nested `bash`/`write`/`edit` interrupted by the restart is not
  run twice (its own replay policy), and the script sees it as interrupted.
- Remote destinations: the script runs on the server, and its coding-tool calls dispatch to the pinned machine.
- Updating pi-durable or pi-codemode can change the replay fingerprint: a script interrupted across that upgrade
  ends with an error instead of replaying.
