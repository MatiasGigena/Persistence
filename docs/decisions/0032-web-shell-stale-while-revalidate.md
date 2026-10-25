# 0032. The web app starts from whole cached versions of its files, revalidated in the background

## Status

Accepted, 2026-10-25. Amends [0020](0020-web-client-without-build.md).

## Context

The web app has no bundler ([0020](0020-web-client-without-build.md)): `main.ts` imports about twenty modules, and
the browser finds them one import level at a time, each level a round trip. The service worker was network first for
every file, so each start also waited on the network for every file, and the cache only helped offline. Over
Tailscale from a phone, that is several round trips before the first screen.

Caching files and serving them before they revalidate (stale while revalidate) removes those waits. But nothing is
content-hashed, and files revalidated one by one could leave a cache that mixes two versions: a new `index.html` with
an old `main.ts` that looks for elements it no longer has, or a new module that imports an export an old one lacks.
Either can stop the app from starting. The app already reloads when `welcome.assets` changes, and that reload must
get the new files, not the cached ones.

## Decision

- **Preloads.** `index.html` has a `<link rel="modulepreload">` for every module the app loads at startup, after the
  import map, so they download in parallel. `test/web/shell.test.ts` holds the list to the service worker's `SHELL`
  modules. The CSP's `script-src 'self'` covers them, and `.ts` is served as `text/javascript`, so the module loads
  reuse the preloads (checked in headless Chromium: no file is fetched twice).
- **Whole sets.** The service worker keeps the shell as sets: a cache `persistence-shell-4/<stamp>` holds every
  `SHELL` file of one version. A set is written whole, from fetches that all succeeded, and marked complete last
  (`/.complete`); one failed fetch leaves the current set as it is. A 404 leaves that file out, as the network would.
- **Each page uses one set.** The worker pins each page (its client id) to the set it started on, and serves all its
  files from that set, never a mix. Sets older than the newest are deleted only when no open page uses them.
- **Navigation is network first, without a timeout.** `/` is one small conditional request, the chat needs the
  server at once anyway (`/api/me`, `/ws`), and its answer is the version check. When it is the newest set's
  `index.html`, the page gets its other files from the set at once, and the whole set revalidates in the background
  (conditional requests, mostly 304s, at low priority so the page's own requests go first). When it differs, or there
  is no set yet, the start waits for a new whole set before answering, so a new `index.html` never meets old modules;
  if that set cannot be fetched, the page gets the cached `index.html` and runs the cached version whole. No network:
  the offline page, as before.
- **Updates.** A revalidation that finds any file changed writes a new set and posts `{t: 'shell', version}` to
  each page that runs on an older set; `main.ts` reloads once for it (keeping unsent text as a draft, as for
  `welcome.assets`). A reload for `welcome.assets` or a protocol change first asks the worker to revalidate
  (`{t: 'refresh'}`, answered on a `MessageChannel` port, at most 5 s), so it lands on the new files directly.

## Consequences

- A start after the first loads its files from the cache; only `index.html` and `/api/me` wait on the network. In
  headless Chromium with 150 ms per request over HTTP/1.1, the first screen of a controlled start went from about
  1.3 s to about 0.55 s.
- After a deploy that changes modules but not `index.html`, the app starts on the old version and reloads once,
  about one round trip later. A changed `index.html` costs that start the old wait instead.
- Every start revalidates the whole shell in the background: about thirty conditional requests, mostly 304s.
- Pins live in the worker's memory. If the browser stops the worker while a page is open, files that page loads
  later come from the newest set; a page loads all its modules at startup, so only images can be affected.
- `SHELL`, the preload list, and the app's imports must stay in step; `test/web/shell.test.ts` checks all three.
