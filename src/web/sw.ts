// The service worker: the app shell from a cache that always holds one whole version of the app, an offline page
// when the server cannot be reached, and push notifications. A classic script (no modules: importScripts loads the
// shell's decisions, sw/shell.ts), so every browser that has service workers can run it; type-checked by
// sw/tsconfig.json (lib WebWorker).
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

importScripts('/sw/shell.ts');

/** Everything the app loads, cached so it can start at once. test/web checks the list stays complete. */
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', OFFLINE,
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
  '/main.ts', '/link.ts', '/store.ts', '/chat-view.ts', '/markdown.ts', '/format.ts', '/push.ts',
  '/panels/sheet.ts', '/panels/agents.ts', '/panels/memory.ts', '/panels/chat-settings.ts', '/panels/tools.ts', '/panels/cache.ts', '/copy.ts',
  '/attach.ts', '/tray.ts', '/outbox.ts', '/link-state.ts', '/ui/text.ts', '/protocol/images.ts',
  '/protocol/messages.ts', '/protocol/machines.ts', '/protocol/mirror.ts', '/protocol/parse.ts', '/protocol/request-error.ts', '/protocol/util.ts', '/protocol/version.ts',
  '/vendor/marked.esm.js',
];

/**
 * The set each page (by client id) loads its files from, fixed by its navigation or first file: `null` for a page that
 * loads from the network (its index.html matched no set). Kept in memory only: a page whose worker restarted gets the
 * newest set for what it loads later.
 */
const pins = new Map<string, { readonly shell: Shell | null; readonly at: number }>();
/** A pin this young is kept though its page is not listed yet (a page just navigated to is not, at first). */
const PIN_GRACE_MS = 30_000;
const pin = (client: string, shell: Shell | null): void => { if (client) pins.set(client, { shell, at: Date.now() }); };

let latest: Promise<Shell | undefined> | undefined;
/** The newest complete set, remembered; `fresh` reads CacheStorage again. */
function current(fresh = false): Promise<Shell | undefined> {
  if (fresh || !latest) latest = newest(caches);
  return latest;
}

/**
 * A shell file, revalidated by the HTTP cache (by ETag). Low priority, so over HTTP/1.1's few connections the page's
 * own `/api/me` and socket go first.
 */
const revalidate = (path: string): Promise<Response> => fetch(new Request(path, { cache: 'no-cache', priority: 'low' }));

/** Revalidates every shell file: the newest set when nothing changed, else a new whole one (`assemble`). */
async function build(seed?: Response): Promise<{ readonly shell: Shell; readonly changed: boolean }> {
  const built = await assemble(caches, revalidate, SHELL, () => current(true), seed);
  if (built.changed) latest = Promise.resolve(built.shell);
  return built;
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
  await Promise.all(stale(await caches.keys(), shell, used).map(name => caches.delete(name)));
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

/**
 * A page load: index.html from the network, else the offline page (the chat itself needs the server). Network first
 * with no timeout: one small conditional request, and the version check that keeps the page and its files one set.
 */
async function page(event: FetchEvent): Promise<Response> {
  const { request, resultingClientId: client } = event;
  let response: Response;
  try { response = await fetch(request); } catch { return offlinePage(await current()); }
  const path = new URL(request.url).pathname;
  const arrival = await arrive(path, response, () => current(true), index => matching(index, refresh));
  if (arrival.pin !== undefined) pin(client, arrival.pin);
  if (arrival.revalidate) event.waitUntil(refresh(response.clone()).catch(() => undefined));
  return arrival.answer;
}

/** Any other app file: from the page's set (stale while the set revalidates), else the network. */
async function asset(request: Request, client: string): Promise<Response> {
  let shell = pins.get(client)?.shell;
  if (shell === undefined) {
    shell = await current() ?? null;
    if (shell) pin(client, shell);
  }
  return fromSet(shell, request, next => fetch(next), () => current());
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
