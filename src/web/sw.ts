// The service worker: the app shell from a cache that always holds one whole version of the app, an offline page
// when the server cannot be reached, and push notifications. A classic script with no imports, so every browser that
// has service workers can run it; type-checked by sw/tsconfig.json (lib WebWorker).
//
// The shell (ADR 0032) is kept in sets: a cache `<CACHE>/<stamp>` holds every file of one version, written whole and
// marked complete last, so a page never runs files of two versions. A start fetches index.html (the chat needs the
// server anyway); when it is the newest set's index.html, the page's files come from that set at once while the whole
// set revalidates in the background (conditional requests: mostly 304s). Any changed file makes a new set, and a page
// that ran on an older set is told to reload once (main.ts). A changed index.html makes its start wait for the new set.

const worker = ((): ServiceWorkerGlobalScope => {
  if (self instanceof ServiceWorkerGlobalScope) return self;
  throw new Error('sw.ts runs only as a service worker');
})();

const CACHE = 'persistence-shell-4';
const OFFLINE = '/offline.html';
/** Written last into a set, so only a whole set is ever used. The server never serves a dot path. */
const COMPLETE = '/.complete';
/** The paths that load the app's index.html; a set keeps it under `/`. */
const INDEX = new Set(['/', '/index.html']);
/** Everything the app loads, cached so it can start at once. test/web checks the list stays complete. */
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', OFFLINE,
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
  '/main.ts', '/link.ts', '/store.ts', '/chat-view.ts', '/markdown.ts', '/format.ts', '/push.ts',
  '/panels/sheet.ts', '/panels/agents.ts', '/panels/memory.ts', '/panels/chat-settings.ts', '/panels/tools.ts', '/panels/cache.ts', '/copy.ts',
  '/attach.ts', '/protocol/images.ts',
  '/protocol/messages.ts', '/protocol/machines.ts', '/protocol/mirror.ts', '/protocol/parse.ts', '/protocol/version.ts',
  '/vendor/marked.esm.js',
];

/** One version of the app's files. */
interface Shell { readonly name: string; readonly cache: Cache }

/**
 * The set each page (by client id) loads its files from, fixed by its navigation or first file: `null` for a page that
 * loads from the network (its index.html matched no set). Kept in memory only: a page whose worker restarted gets the
 * newest set for what it loads later.
 */
const pins = new Map<string, { readonly shell: Shell | null; readonly at: number }>();
/** A pin this young is kept though its page is not listed yet (a page just navigated to is not, at first). */
const PIN_GRACE_MS = 30_000;
const pin = (client: string, shell: Shell | null): void => { if (client) pins.set(client, { shell, at: Date.now() }); };
const stamp = (name: string): number => Number(name.slice(CACHE.length + 1)) || 0;
const isSet = (name: string): boolean => name.startsWith(`${CACHE}/`);

/** The newest complete set, read from CacheStorage (another version of this worker may have written one). */
async function newest(): Promise<Shell | undefined> {
  const names = (await caches.keys()).filter(isSet).sort((a, b) => stamp(b) - stamp(a));
  // Every set is opened and checked at once; the newest complete one wins.
  const sets = await Promise.all(names.map(async name => {
    const cache = await caches.open(name);
    return await cache.match(COMPLETE) ? { name, cache } : undefined;
  }));
  return sets.find(set => set !== undefined);
}

let latest: Promise<Shell | undefined> | undefined;
/** The newest complete set, remembered; `fresh` reads CacheStorage again. */
function current(fresh = false): Promise<Shell | undefined> {
  if (fresh || !latest) latest = newest();
  return latest;
}

/** Whether two answers for one file are the same bytes: by ETag (the server gives every file one), else by body. */
async function same(a: Response, b: Response): Promise<boolean> {
  const [x, y] = [a.headers.get('ETag'), b.headers.get('ETag')];
  if (x && y) return x === y;
  const [p, q] = (await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()])).map(buffer => new Uint8Array(buffer));
  return p !== undefined && q !== undefined && p.length === q.length && p.every((byte, at) => byte === q[at]);
}

/** The shell's files as the server has them now: a 404 is kept (and left out of a set), any other error throws. */
async function fetchShell(seed?: Response): Promise<Array<readonly [string, Response]>> {
  return Promise.all(SHELL.map(async path => {
    const response = path === '/' && seed ? seed : await fetch(new Request(path, { cache: 'no-cache', priority: 'low' }));
    if (!response.ok && response.status !== 404) throw new Error(`${path}: HTTP ${response.status}`);
    return [path, response] as const;
  }));
}

/** How many times a build fetches the shell before it gives up on a server that keeps changing under it. */
const BUILD_TRIES = 3;

/**
 * The shell's files, all of one version. The files are fetched in parallel, so a deploy that lands mid-fetch could
 * give some files of each version: every file is fetched once more (mostly 304s) and the two rounds must agree, else
 * the whole fetch is tried again. Throws when the server never holds still, so a mixed set is never marked complete.
 */
async function fetchStable(seed?: Response): Promise<Array<readonly [string, Response]>> {
  for (let tries = 0; tries < BUILD_TRIES; tries++) {
    const answers = await fetchShell(tries === 0 ? seed : undefined);
    const check = await fetchShell();
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
 * Fetches every shell file again (`no-cache`: the HTTP cache revalidates each by ETag) and returns the set they make:
 * the newest set when nothing changed, else a new one, written whole before it is marked complete. `seed` is a fresh
 * answer for `/` already in hand. Throws when any file cannot be fetched, or the files do not settle on one version
 * (`fetchStable`), so a set is never half new; a file the server does not have (404) is left out, as it would be on the
 * network. The fetches are low priority, so over HTTP/1.1's few connections the page's own `/api/me` and socket go first.
 */
async function build(seed?: Response): Promise<{ readonly shell: Shell; readonly changed: boolean }> {
  const answers = await fetchStable(seed);
  const found = answers.filter(([, response]) => response.ok);
  const old = await current(true);
  if (old && (await old.cache.keys()).length === found.length + 1) {
    const kept = await Promise.all(found.map(async ([path, response]) => {
      const cached = await old.cache.match(path);
      return cached !== undefined && await same(cached, response);
    }));
    if (kept.every(Boolean)) return { shell: old, changed: false };
  }
  const name = `${CACHE}/${Math.max(Date.now(), old ? stamp(old.name) + 1 : 0)}`;
  const cache = await caches.open(name);
  await Promise.all(found.map(([path, response]) => cache.put(path, response.clone())));
  await cache.put(COMPLETE, new Response(name));
  const shell = { name, cache };
  latest = Promise.resolve(shell);
  return { shell, changed: true };
}

/** Tells each page that runs on an older set that a new one is in: main.ts reloads once for it. */
async function announce(shell: Shell): Promise<void> {
  const version = String(stamp(shell.name));
  await Promise.all([...pins].filter(([, { shell: pinned }]) => pinned && pinned.name !== shell.name)
    .map(async ([id]) => (await worker.clients.get(id))?.postMessage({ t: 'shell', version })));
}

/** Forgets closed pages, and deletes the sets older than `shell` that no open page loads from. */
async function prune(shell: Shell): Promise<void> {
  const open = new Set((await worker.clients.matchAll({ type: 'all' })).map(client => client.id));
  for (const [id, { at }] of pins) if (!open.has(id) && Date.now() - at > PIN_GRACE_MS) pins.delete(id);
  const used = new Set([...pins.values()].map(({ shell: pinned }) => pinned?.name));
  const old = (await caches.keys()).filter(name => isSet(name) && stamp(name) < stamp(shell.name) && !used.has(name));
  await Promise.all(old.map(name => caches.delete(name)));
}

let building: Promise<Shell> | undefined;
/** Revalidates the shell, one build at a time (a caller joins the one running); see `build`. */
function refresh(seed?: Response): Promise<Shell> {
  building ??= build(seed).then(async ({ shell, changed }) => {
    if (changed) await announce(shell);
    await prune(shell);
    return shell;
  }).finally(() => { building = undefined; });
  return building;
}

/** A set whose index.html is `index`, built now if need be (a joined build may predate it: then once more). */
async function matching(index: Response): Promise<Shell | undefined> {
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

async function offline(): Promise<Response> {
  return await (await current())?.cache.match(OFFLINE)
    ?? new Response('Connect to Tailscale, then reload.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * A page load: index.html from the network, else the offline page (the chat itself needs the server). Network first
 * with no timeout: one small conditional request, and the version check that keeps the page and its files one set.
 */
async function page(event: FetchEvent): Promise<Response> {
  const { request, resultingClientId: client } = event;
  let response: Response;
  try { response = await fetch(request); } catch { return offline(); }
  // The server is down (a restart) while the tailnet is up: run the set in hand, which reconnects by itself.
  if (unreachable(response) && INDEX.has(new URL(request.url).pathname)) {
    const kept = await current(true);
    const index = await kept?.cache.match('/');
    if (kept && index) {
      pin(client, kept);
      return index;
    }
  }
  // `/index.html` is the same page as `/`: both check against the set's index.html, kept under `/`.
  if (!response.ok || !INDEX.has(new URL(request.url).pathname)) return response;
  const shell = await current(true);
  const cached = await shell?.cache.match('/');
  if (shell && cached && await same(cached, response)) {
    // The newest set's version: its files at once, the whole set revalidated meanwhile.
    pin(client, shell);
    event.waitUntil(refresh(response.clone()).catch(() => undefined));
    return response;
  }
  // A new index.html (or no set yet): wait for the set it belongs to, so the page never meets older modules.
  const fresh = await matching(response.clone()).catch(() => undefined);
  if (fresh) {
    pin(client, fresh);
    return response;
  }
  // No new set could be fetched whole: run the version in hand, whole, rather than a mix.
  if (shell && cached) {
    pin(client, shell);
    return cached;
  }
  pin(client, null);
  return response;
}

/** Any other app file: from the page's set (stale while the set revalidates), else the network. */
async function asset(request: Request, client: string): Promise<Response> {
  let shell = pins.get(client)?.shell;
  if (shell === undefined) {
    shell = await current() ?? null;
    if (shell) pin(client, shell);
  }
  // A set another version of this worker deleted answers nothing: the network then.
  const hit = await shell?.cache.match(request).catch(() => undefined);
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await (await current())?.cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

worker.addEventListener('install', event => {
  // A set that cannot be fetched whole now is built by the next start instead: the worker installs anyway (push).
  event.waitUntil(build().catch(() => undefined).then(() => worker.skipWaiting()));
});

worker.addEventListener('activate', event => {
  // Older versions' caches go; this version's sets stay, and refresh prunes them.
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => !isSet(key)).map(key => caches.delete(key))))
    .then(() => worker.clients.claim()));
});

worker.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== worker.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(request.mode === 'navigate' ? page(event) : asset(request, event.clientId));
});

/** `{t: 'refresh'}` from a page about to reload for new files (main.ts): revalidate first, then answer on the port. */
worker.addEventListener('message', event => {
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null || !('t' in data) || data.t !== 'refresh') return;
  const [port] = event.ports;
  event.waitUntil(refresh().then(() => true, () => false).then(ok => port?.postMessage({ t: 'refreshed', ok })));
});

/** The push payload (docs/protocol.md, push.subscribe): `{title, body, tag}`. Anything else gets a plain notice. */
function payload(data: PushMessageData | null): { title: string; body: string; tag: string } {
  const fallback = { title: 'Persistence', body: 'Pi has news.', tag: 'pi' };
  if (!data) return fallback;
  let value: unknown;
  try { value = data.json(); } catch { return { ...fallback, body: data.text() }; }
  if (typeof value !== 'object' || value === null) return fallback;
  const field = (key: string, otherwise: string): string => {
    const found: unknown = Object.entries(value).find(([name]) => name === key)?.[1];
    return typeof found === 'string' && found ? found : otherwise;
  };
  return { title: field('title', fallback.title), body: field('body', ''), tag: field('tag', fallback.tag) };
}

worker.addEventListener('push', event => {
  const { title, body, tag } = payload(event.data);
  // The tag replaces an earlier notification with the same tag: one per conversation, not one per reply.
  event.waitUntil(worker.registration.showNotification(title, {
    body, tag, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: '/' },
  }));
});

worker.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === worker.location.origin);
    if (open) await open.focus();
    else await worker.clients.openWindow('/');
  })());
});
