// The service worker: the app shell, network first (every file revalidates; the cache only covers being offline),
// an offline page when the server cannot be reached at all, and push notifications. A classic script with no
// imports, so every browser that has service workers can run it; type-checked by sw/tsconfig.json (lib WebWorker).

const worker = ((): ServiceWorkerGlobalScope => {
  if (self instanceof ServiceWorkerGlobalScope) return self;
  throw new Error('sw.ts runs only as a service worker');
})();

const CACHE = 'persistence-shell-1';
const OFFLINE = '/offline.html';
/** Everything the app loads, cached at install so it can start offline. test/web checks the list stays complete. */
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', OFFLINE,
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
  '/main.ts', '/link.ts', '/store.ts', '/chat-view.ts', '/markdown.ts', '/format.ts', '/push.ts',
  '/panels/sheet.ts', '/panels/agents.ts', '/panels/memory.ts', '/panels/model.ts', '/panels/tools.ts', '/panels/settings.ts',
  '/protocol/messages.ts', '/protocol/mirror.ts', '/protocol/parse.ts', '/protocol/version.ts',
  '/vendor/marked.esm.js',
];

worker.addEventListener('install', event => {
  // One missing file must not stop the rest (or the offline page) from being cached.
  event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(SHELL.map(path => cache.add(new Request(path, { cache: 'reload' })))))
    .then(() => worker.skipWaiting()));
});

worker.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => worker.clients.claim()));
});

/** The network's answer, kept for offline use; the cached copy when the network fails. */
async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

/** A page load: the network, else the offline page (the chat itself needs the server). */
async function page(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && new URL(request.url).pathname === '/') await cache.put('/', response.clone());
    return response;
  } catch {
    return await cache.match(OFFLINE) ?? new Response('Connect to Tailscale, then reload.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

worker.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== worker.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(request.mode === 'navigate' ? page(request) : networkFirst(request));
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
