# 0020. A web client without a build step

## Status

Accepted, 2026-10-19 (`src/server/static.ts`, `src/web/`). Extends [0011](0011-typescript-without-build.md). Amended by
[0032](0032-web-shell-stale-while-revalidate.md).

## Context

The phone needs a web app: the chat, agents, memory, models and tools, installable as a home-screen app on iOS
16.4+ and Android, with push. The project has no build step ([0011](0011-typescript-without-build.md)), pins few
dependencies, and its protocol code (`src/protocol/`) is plain, erasable TypeScript with no Node imports.

## Decision

- `src/web/` is vanilla DOM TypeScript: `main.ts`, `link.ts` (WebSocket and reconnect), `store.ts` (the mirror),
  `chat-view.ts`, `markdown.ts`, `panels/*`, `push.ts`, and the service worker `sw.ts`. No framework, no bundler.
- The server serves `.ts` files type-stripped at request time with `node:module` `stripTypeScriptTypes` (cached
  until the file's mtime or size changes), as `text/javascript`; the browser loads them as ES modules. `src/protocol/` is served the same
  way, so the browser runs the exact parser and mirror the server tests.
- `src/web/tsconfig.json` (lib DOM) and `src/web/sw/tsconfig.json` (lib WebWorker) type-check them; `npm run check`
  runs both. `src/ui/types.ts` imports nothing, so they resolve it without Node types.
- Markdown uses `marked`, already installed through pi-tui (18.0.11), pinned as a direct dependency and served
  from `node_modules`. The WebSocket server uses `ws` (8.22.0, already installed), pinned likewise.
- A strict Content-Security-Policy: `default-src 'self'`, no inline scripts but `index.html`'s import map (allowed
  by its sha256, computed when the server reads the file), no `eval`, `connect-src` the origin only. Rendered
  Markdown is sanitized (no raw HTML).
- `welcome.assets` is a hash of the served files; a client seeing it change reloads.

## Consequences

- Editing a web file needs only a browser reload; stack traces show the source.
- No tree shaking or minification: the app is a few hundred KiB, cached by the service worker. Without a bundler,
  imports are found one level at a time; `index.html` preloads every startup module instead ([0032](0032-web-shell-stale-while-revalidate.md)).
- `stripTypeScriptTypes` is experimental in Node 22; the server pins its use to `mode: 'strip'` and the engines
  floor.
