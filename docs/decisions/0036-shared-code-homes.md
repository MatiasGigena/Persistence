# 0036. One home for code that several layers share

## Status

Accepted, 2026-11-04. Amends [0020](0020-web-client-without-build.md) (`src/ui/types.ts` imports protocol types, and
`src/ui/text.ts` is served too).

## Context

Small helpers and wording had been copied wherever they were needed. The error-to-text ternary was written out about
30 times under eight names; the plain-object guard six times under five; `REPORT_KIND` in two modules. The terminal UI
and `src/web/format.ts` held verbatim copies of the tool summaries, archive prompts, the `/status` block and the zoom
parsers, kept equal only by tests, and the web copy of `/status` had already lost a line. The server chose wire error
codes by matching the text of errors thrown in other modules. Server, client and UI modules imported the CLI options
module or the memory package just to reach a helper.

## Decision

Each shared piece has one home, chosen by who must load it:

- `src/protocol/util.ts`: `isRecord`, `errorMessage`, `errorCode`. `src/protocol/` is already Node- and DOM-free and
  served to the browser, so every layer, the web app included, imports the same copy.
- `src/protocol/images.ts` and `src/protocol/machines.ts` own `ChatImage` and `MachineTarget`; `src/ui/types.ts`
  imports them as types. The contract still loads nothing the browser cannot, and the server, routing and the machine
  executor no longer reach into `src/ui/` for wire types.
- `src/ui/text.ts`: the wording both front ends show. It imports no DOM, Node or pi-tui, so the terminal UI imports
  it and the static server serves it at `/ui/text.ts`. `src/ui/` is served from an allow-list (`types.ts`, `text.ts`).
- `src/ui/errors.ts`: `NotFound` and `Unavailable`, thrown by the session and the agents core.
  `Connection.request` is the one place an error becomes a wire code.
- `src/runtime/files.ts` (fsynced writes), `src/runtime/thinking.ts` (reasoning efforts) and `src/agents/entries.ts`
  (input entry kinds and their decoder): leaves that load nothing heavy, so the CLI, the memory and the UI share them.
- `UiSession.send`, `Instance.submit` and `MachineRouting.submit` take one `SendOptions` object instead of positional
  optionals whose order differed at each layer.

## Consequences

- A new helper goes beside these, not into the module that first needs it; AGENTS.md names them.
- Rewording an error message cannot change a wire code, and no test exists only to keep two copies equal.
- tsc runs with `noUnusedLocals`, so an import left behind by a move fails the check.
