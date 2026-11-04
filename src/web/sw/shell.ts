// The shell's caching decisions (ADR 0032), loaded by sw.ts with importScripts: a classic script, so its top-level
// names are the worker's globals and it uses none of the worker's own. It reaches caches and the network only through
// the small interfaces below, so test/web/sw.test.ts runs it in Node against in-memory fakes.

/** The part of a `Cache` the shell uses. */
interface ShellCache {
  match(request: string | Request): Promise<Response | undefined>;
  put(path: string, response: Response): Promise<void>;
  keys(): Promise<readonly unknown[]>;
}

/** The part of `CacheStorage` the shell uses. */
interface ShellCaches {
  keys(): Promise<string[]>;
  open(name: string): Promise<ShellCache>;
  delete(name: string): Promise<boolean>;
}

/** Fetches one shell file by path, revalidating it. */
type ShellFetch = (path: string) => Promise<Response>;

/** One version of the app's files. */
interface Shell { readonly name: string; readonly cache: ShellCache }

const CACHE = 'persistence-shell-4';
const OFFLINE = '/offline.html';
/** Written last into a set, so only a whole set is ever used. The server never serves a dot path. */
const COMPLETE = '/.complete';
/** The paths that load the app's index.html; a set keeps it under `/`. */
const INDEX = new Set(['/', '/index.html']);
/** How many times a build fetches the shell before it gives up on a server that keeps changing under it. */
const BUILD_TRIES = 3;

const stamp = (name: string): number => Number(name.slice(CACHE.length + 1)) || 0;
const isSet = (name: string): boolean => name.startsWith(`${CACHE}/`);

/** The newest complete set in `store` (another version of the worker may have written one). */
async function newest(store: ShellCaches): Promise<Shell | undefined> {
  const names = (await store.keys()).filter(isSet).sort((a, b) => stamp(b) - stamp(a));
  // Every set is opened and checked at once; the newest complete one wins.
  const sets = await Promise.all(names.map(async name => {
    const cache = await store.open(name);
    return await cache.match(COMPLETE) ? { name, cache } : undefined;
  }));
  return sets.find(set => set !== undefined);
}

/** Whether two answers for one file are the same bytes: by ETag (the server gives every file one), else by body. */
async function same(a: Response, b: Response): Promise<boolean> {
  const [x, y] = [a.headers.get('ETag'), b.headers.get('ETag')];
  if (x && y) return x === y;
  const [p, q] = (await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()])).map(buffer => new Uint8Array(buffer));
  return p !== undefined && q !== undefined && p.length === q.length && p.every((byte, at) => byte === q[at]);
}

/** The shell's files as the server has them now: a 404 is kept (and left out of a set), any other error throws. */
async function fetchShell(
  fetchFile: ShellFetch, paths: readonly string[], seed?: Response,
): Promise<Array<readonly [string, Response]>> {
  return Promise.all(paths.map(async path => {
    const response = path === '/' && seed ? seed : await fetchFile(path);
    if (!response.ok && response.status !== 404) throw new Error(`${path}: HTTP ${response.status}`);
    return [path, response] as const;
  }));
}

/**
 * The shell's files, all of one version. The files are fetched in parallel, so a deploy that lands mid-fetch could
 * give some files of each version: every file is fetched once more (mostly 304s) and the two rounds must agree, else
 * the whole fetch is tried again. Throws when the server never holds still, so a mixed set is never marked complete.
 */
async function fetchStable(
  fetchFile: ShellFetch, paths: readonly string[], seed?: Response,
): Promise<Array<readonly [string, Response]>> {
  for (let tries = 0; tries < BUILD_TRIES; tries++) {
    const answers = await fetchShell(fetchFile, paths, tries === 0 ? seed : undefined);
    const check = await fetchShell(fetchFile, paths);
    const agree = await Promise.all(answers.map(async ([, response], at) => {
      const again = check[at]?.[1];
      if (!again || again.status !== response.status) return false;
      return !response.ok || await same(response, again);
    }));
    if (agree.every(Boolean)) return answers;
  }
  throw new Error('the shell changed while it was fetched');
}

/**
 * Fetches every shell file again and returns the set they make: `previous` (the newest set, read after the fetch)
 * when nothing changed, else a new one, written whole before it is marked complete. `seed` is a fresh answer for `/`
 * already in hand. Throws when any file cannot be fetched, or the files do not settle on one version (`fetchStable`),
 * so a set is never half new; a file the server does not have (404) is left out, as it would be on the network.
 */
async function assemble(
  store: ShellCaches, fetchFile: ShellFetch, paths: readonly string[],
  previous: () => Promise<Shell | undefined>, seed?: Response,
): Promise<{ readonly shell: Shell; readonly changed: boolean }> {
  const answers = await fetchStable(fetchFile, paths, seed);
  const found = answers.filter(([, response]) => response.ok);
  const old = await previous();
  if (old && (await old.cache.keys()).length === found.length + 1) {
    const kept = await Promise.all(found.map(async ([path, response]) => {
      const cached = await old.cache.match(path);
      return cached !== undefined && await same(cached, response);
    }));
    if (kept.every(Boolean)) return { shell: old, changed: false };
  }
  const name = `${CACHE}/${Math.max(Date.now(), old ? stamp(old.name) + 1 : 0)}`;
  const cache = await store.open(name);
  await Promise.all(found.map(([path, response]) => cache.put(path, response.clone())));
  await cache.put(COMPLETE, new Response(name));
  return { shell: { name, cache }, changed: true };
}

/** Of the cache `names`, the sets to delete: those older than `shell` that no open page loads from (`used`). */
function stale(names: readonly string[], shell: Shell, used: ReadonlySet<string | undefined>): string[] {
  return names.filter(name => isSet(name) && stamp(name) < stamp(shell.name) && !used.has(name));
}

/** A set whose index.html is `index`, built now if need be (a joined build may predate it: then once more). */
async function matching(index: Response, refresh: (seed: Response) => Promise<Shell>): Promise<Shell | undefined> {
  for (let tries = 0; tries < 2; tries++) {
    const shell = await refresh(index.clone());
    const cached = await shell.cache.match('/');
    if (cached && await same(cached, index)) return shell;
  }
  return undefined;
}

/**
 * `tailscale serve` answers 502 while the server is down (a restart): the tailnet is up, so the app starts from its
 * set and reconnects by itself, rather than leaving a bare error page.
 */
const unreachable = (response: Response): boolean => response.status >= 502 && response.status <= 504;

/** The answer when the server cannot be reached: the set's offline page, else a plain notice. */
async function offlinePage(shell: Shell | undefined): Promise<Response> {
  return await shell?.cache.match(OFFLINE)
    ?? new Response('Connect to Tailscale, then reload.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

/** A page load's answer, the set to pin its page to (`null`: the network; absent: no pin), and whether to revalidate. */
interface Arrival { readonly answer: Response; readonly pin?: Shell | null; readonly revalidate?: boolean }

/**
 * Settles a page load at `path` that the network answered with `response`, keeping the page and its files one set.
 * `newestSet` reads the newest set afresh; `match` finds or builds the set of a new index.html (`matching`).
 */
async function arrive(
  path: string, response: Response,
  newestSet: () => Promise<Shell | undefined>, match: (index: Response) => Promise<Shell | undefined>,
): Promise<Arrival> {
  // The server is down (a restart) while the tailnet is up: run the set in hand, which reconnects by itself.
  if (unreachable(response) && INDEX.has(path)) {
    const kept = await newestSet();
    const index = await kept?.cache.match('/');
    if (kept && index) return { answer: index, pin: kept };
  }
  // `/index.html` is the same page as `/`: both check against the set's index.html, kept under `/`.
  if (!response.ok || !INDEX.has(path)) return { answer: response };
  const shell = await newestSet();
  const cached = await shell?.cache.match('/');
  // The newest set's version: its files at once, the whole set revalidated meanwhile.
  if (shell && cached && await same(cached, response)) return { answer: response, pin: shell, revalidate: true };
  // A new index.html (or no set yet): wait for the set it belongs to, so the page never meets older modules.
  const fresh = await match(response.clone()).catch(() => undefined);
  if (fresh) return { answer: response, pin: fresh };
  // No new set could be fetched whole: run the version in hand, whole, rather than a mix.
  if (shell && cached) return { answer: cached, pin: shell };
  return { answer: response, pin: null };
}

/** An app file for a page on `shell`: from the set, else the network, else (offline) the newest set. */
async function fromSet(
  shell: Shell | null, request: Request,
  fetchRequest: (request: Request) => Promise<Response>, newestSet: () => Promise<Shell | undefined>,
): Promise<Response> {
  // A set another version of the worker deleted answers nothing: the network then.
  const hit = await shell?.cache.match(request).catch(() => undefined);
  if (hit) return hit;
  try {
    return await fetchRequest(request);
  } catch (error) {
    const cached = await (await newestSet())?.cache.match(request);
    if (cached) return cached;
    throw error;
  }
}
