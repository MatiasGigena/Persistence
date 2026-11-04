// The service worker's shell decisions (src/web/sw/shell.ts) against in-memory caches and a fake server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

interface FakeCache {
  readonly entries: Map<string, Response>;
  readonly puts: string[];
  match(request: string | Request): Promise<Response | undefined>;
  put(path: string, response: Response): Promise<void>;
  keys(): Promise<readonly unknown[]>;
}
interface Shell { readonly name: string; readonly cache: FakeCache }
interface Store {
  keys(): Promise<string[]>;
  open(name: string): Promise<FakeCache>;
  delete(name: string): Promise<boolean>;
}
interface Arrival { readonly answer: Response; readonly pin?: Shell | null; readonly revalidate?: boolean }
type Newest = () => Promise<Shell | undefined>;

/** The globals sw/shell.ts gives the worker, as this test uses them. */
interface ShellScript {
  readonly CACHE: string;
  readonly COMPLETE: string;
  readonly OFFLINE: string;
  newest(store: Store): Promise<Shell | undefined>;
  same(a: Response, b: Response): Promise<boolean>;
  fetchStable(fetchFile: (path: string) => Promise<Response>, paths: readonly string[], seed?: Response): Promise<Array<readonly [string, Response]>>;
  assemble(
    store: Store, fetchFile: (path: string) => Promise<Response>, paths: readonly string[], previous: Newest, seed?: Response,
  ): Promise<{ readonly shell: Shell; readonly changed: boolean }>;
  stale(names: readonly string[], shell: Shell, used: ReadonlySet<string | undefined>): string[];
  matching(index: Response, refresh: (seed: Response) => Promise<Shell>): Promise<Shell | undefined>;
  offlinePage(shell: Shell | undefined): Promise<Response>;
  arrive(path: string, response: Response, newestSet: Newest, match: (index: Response) => Promise<Shell | undefined>): Promise<Arrival>;
  fromSet(shell: Shell | null, request: Request, fetchRequest: (request: Request) => Promise<Response>, newestSet: Newest): Promise<Response>;
}

// A classic script (the worker loads it with importScripts), so it is run as one and its globals are collected.
const source = stripTypeScriptTypes(await readFile(new URL('../../src/web/sw/shell.ts', import.meta.url), 'utf8'), { mode: 'strip' });
const NAMES = ['CACHE', 'COMPLETE', 'OFFLINE', 'newest', 'same', 'fetchStable', 'assemble', 'stale', 'matching', 'offlinePage', 'arrive', 'fromSet'];
const load = new Function(`${source}\nreturn { ${NAMES.join(', ')} };`) as () => unknown;
const sw = load() as ShellScript;

function fakeCache(): FakeCache {
  const entries = new Map<string, Response>();
  const puts: string[] = [];
  const key = (request: string | Request): string => (typeof request === 'string' ? request : new URL(request.url).pathname);
  return {
    entries, puts,
    match: request => Promise.resolve(entries.get(key(request))?.clone()),
    put: (path, response) => { puts.push(path); entries.set(path, response); return Promise.resolve(); },
    keys: () => Promise.resolve([...entries.keys()]),
  };
}

function fakeStore(): Store & { readonly caches: Map<string, FakeCache> } {
  const caches = new Map<string, FakeCache>();
  return {
    caches,
    keys: () => Promise.resolve([...caches.keys()]),
    open: name => {
      const cache = caches.get(name) ?? fakeCache();
      caches.set(name, cache);
      return Promise.resolve(cache);
    },
    delete: name => Promise.resolve(caches.delete(name)),
  };
}

const file = (body: string, etag?: string, status = 200): Response =>
  new Response(status === 404 ? 'missing' : body, { status, headers: etag ? { ETag: etag } : {} });

/** A server whose files are at `version`; `onFetch` may change it mid-build (a deploy). */
function fakeServer(files: Record<string, string>) {
  const server = { version: 1, fetches: 0, onFetch: (): void => undefined };
  const fetchFile = (path: string): Promise<Response> => {
    server.fetches++;
    server.onFetch();
    const body = files[path];
    return Promise.resolve(body === undefined ? file('', undefined, 404) : file(`${body} v${server.version}`, `"${path}@${server.version}"`));
  };
  return { server, fetchFile };
}

async function completeSet(store: Store, stamp: number, files: Record<string, Response>): Promise<Shell> {
  const name = `${sw.CACHE}/${stamp}`;
  const cache = await store.open(name);
  for (const [path, response] of Object.entries(files)) await cache.put(path, response);
  await cache.put(sw.COMPLETE, new Response(name));
  return { name, cache };
}

const PATHS = ['/', '/main.ts', '/styles.css'];
const FILES = { '/': 'index', '/main.ts': 'main', '/styles.css': 'css' };

test('same compares by ETag when both have one, else by bytes', async () => {
  assert.equal(await sw.same(file('a', '"1"'), file('b', '"1"')), true);
  assert.equal(await sw.same(file('a', '"1"'), file('a', '"2"')), false);
  assert.equal(await sw.same(file('abc'), file('abc', '"1"')), true);
  assert.equal(await sw.same(file('abc'), file('abd')), false);
  assert.equal(await sw.same(file('abc'), file('ab')), false);
});

test('only a complete set is used, the newest one', async () => {
  const store = fakeStore();
  assert.equal(await sw.newest(store), undefined);
  await completeSet(store, 100, { '/': file('old') });
  await completeSet(store, 200, { '/': file('mid') });
  // A newer set whose writing stopped before its marker, and a cache that is no set at all.
  await (await store.open(`${sw.CACHE}/300`)).put('/', file('half'));
  await store.open('persistence-shell-3');
  assert.equal((await sw.newest(store))?.name, `${sw.CACHE}/200`);
});

test('a new set is written whole and marked complete last', async () => {
  const store = fakeStore();
  const { fetchFile } = fakeServer(FILES);
  const { shell, changed } = await sw.assemble(store, fetchFile, [...PATHS, '/gone.ts'], () => sw.newest(store));
  assert.equal(changed, true);
  assert.equal(shell.cache.puts.at(-1), sw.COMPLETE);
  assert.deepEqual([...shell.cache.puts].sort(), [...PATHS, sw.COMPLETE].sort(), 'a 404 is left out');
  assert.equal((await sw.newest(store))?.name, shell.name);
});

test('a set that fails mid-write is never marked complete, so the old one stays in use', async () => {
  const store = fakeStore();
  const old = await completeSet(store, 100, { '/': file('index v0', '"/@0"') });
  const open = store.open.bind(store);
  store.open = async name => {
    const cache = await open(name);
    if (name !== old.name) cache.put = () => Promise.reject(new Error('quota'));
    return cache;
  };
  await assert.rejects(sw.assemble(store, fakeServer(FILES).fetchFile, PATHS, () => sw.newest(store)), /quota/);
  assert.equal((await sw.newest(store))?.name, old.name);
});

test('an unchanged server keeps the set; any changed file makes a newer one', async () => {
  const store = fakeStore();
  const { server, fetchFile } = fakeServer(FILES);
  const first = await sw.assemble(store, fetchFile, PATHS, () => sw.newest(store));
  const again = await sw.assemble(store, fetchFile, PATHS, () => sw.newest(store));
  assert.deepEqual([again.changed, again.shell.name], [false, first.shell.name]);
  assert.equal(store.caches.size, 1);
  server.version = 2;
  const next = await sw.assemble(store, fetchFile, PATHS, () => sw.newest(store));
  assert.equal(next.changed, true);
  const stamp = (name: string): number => Number(name.slice(sw.CACHE.length + 1));
  assert.ok(stamp(next.shell.name) > stamp(first.shell.name));
  assert.equal(await (await next.shell.cache.match('/main.ts'))?.text(), 'main v2');
});

test('a deploy mid-fetch is fetched again, and a server that never settles is refused', async () => {
  const { server, fetchFile } = fakeServer(FILES);
  // The second file of the first round already comes from the new version.
  server.onFetch = () => { if (server.fetches === 2) server.version = 2; };
  const answers = await sw.fetchStable(fetchFile, PATHS);
  assert.deepEqual(await Promise.all(answers.map(([, response]) => response.text())), ['index v2', 'main v2', 'css v2']);
  assert.equal(server.fetches, 4 * PATHS.length, 'one disagreeing round, then one that agrees');

  const store = fakeStore();
  const restless = fakeServer(FILES);
  restless.server.onFetch = () => { restless.server.version++; };
  await assert.rejects(sw.assemble(store, restless.fetchFile, PATHS, () => sw.newest(store)), /changed while it was fetched/);
  assert.equal(restless.server.fetches, 3 * 2 * PATHS.length, 'three tries of two rounds');
  assert.equal(await sw.newest(store), undefined, 'no set is marked complete');
});

test('a file that answers a server error fails the fetch; the seed stands in for / on the first round only', async () => {
  const broken = (path: string): Promise<Response> => Promise.resolve(path === '/main.ts' ? file('', undefined, 500) : file(path, `"${path}"`));
  await assert.rejects(sw.fetchStable(broken, PATHS), /\/main\.ts: HTTP 500/);
  const { fetchFile } = fakeServer(FILES);
  const answers = await sw.fetchStable(fetchFile, PATHS, file('index v1', '"/@1"'));
  assert.equal(await answers[0]?.[1].text(), 'index v1');
});

test('prune deletes only sets older than the newest that no page uses', () => {
  const name = (stamp: number): string => `${sw.CACHE}/${stamp}`;
  const shell = { name: name(300), cache: fakeCache() };
  const names = ['persistence-shell-3', name(100), name(200), name(300), name(400)];
  assert.deepEqual(sw.stale(names, shell, new Set([name(200), undefined])), [name(100)]);
  assert.deepEqual(sw.stale(names, shell, new Set()), [name(100), name(200)]);
});

test('an index request resolves within the newest set it matches, revalidated meanwhile', async () => {
  const store = fakeStore();
  const shell = await completeSet(store, 100, { '/': file('index v1', '"i1"') });
  const noBuild = (): Promise<Shell | undefined> => Promise.reject(new Error('no build wanted'));
  for (const path of ['/', '/index.html']) {
    const arrival = await sw.arrive(path, file('index v1', '"i1"'), () => sw.newest(store), noBuild);
    assert.equal(arrival.pin?.name, shell.name);
    assert.equal(arrival.revalidate, true);
    assert.equal(await arrival.answer.text(), 'index v1');
  }
  // Any other page, or an error, is the network's answer and pins nothing.
  const other = await sw.arrive('/other.html', file('other'), () => sw.newest(store), noBuild);
  assert.deepEqual([await other.answer.text(), 'pin' in other], ['other', false]);
  const missing = await sw.arrive('/', file('', undefined, 404), () => sw.newest(store), noBuild);
  assert.deepEqual([missing.answer.status, 'pin' in missing], [404, false]);
});

test('a new index waits for its set, else runs the old set whole, else the network', async () => {
  const store = fakeStore();
  const old = await completeSet(store, 100, { '/': file('index v1', '"i1"') });
  const fresh = { name: `${sw.CACHE}/200`, cache: fakeCache() };
  await fresh.cache.put('/', file('index v2', '"i2"'));
  const built = await sw.arrive('/', file('index v2', '"i2"'), () => sw.newest(store), () => Promise.resolve(fresh));
  assert.deepEqual([built.pin?.name, built.revalidate, await built.answer.text()], [fresh.name, undefined, 'index v2']);

  const failed = (): Promise<Shell | undefined> => Promise.reject(new Error('offline mid-build'));
  const kept = await sw.arrive('/', file('index v2', '"i2"'), () => sw.newest(store), failed);
  assert.deepEqual([kept.pin?.name, await kept.answer.text()], [old.name, 'index v1']);

  const none = await sw.arrive('/', file('index v2', '"i2"'), () => Promise.resolve(undefined), failed);
  assert.deepEqual([none.pin, await none.answer.text()], [null, 'index v2']);
});

test('while the server restarts (502-504) the set in hand starts the app', async () => {
  const store = fakeStore();
  const old = await completeSet(store, 100, { '/': file('index v1', '"i1"') });
  const restart = await sw.arrive('/', file('Bad Gateway', undefined, 502), () => sw.newest(store), () => Promise.resolve(undefined));
  assert.deepEqual([restart.pin?.name, await restart.answer.text()], [old.name, 'index v1']);
  const bare = await sw.arrive('/', file('Bad Gateway', undefined, 502), () => Promise.resolve(undefined), () => Promise.resolve(undefined));
  assert.equal(bare.answer.status, 502);
});

test('matching builds once more when the joined build predates the index', async () => {
  const stale = { name: `${sw.CACHE}/1`, cache: fakeCache() };
  await stale.cache.put('/', file('index v1', '"i1"'));
  const fresh = { name: `${sw.CACHE}/2`, cache: fakeCache() };
  await fresh.cache.put('/', file('index v2', '"i2"'));
  const builds = [stale, fresh];
  let calls = 0;
  const refresh = (): Promise<Shell> => Promise.resolve(builds[calls++] ?? stale);
  assert.equal((await sw.matching(file('index v2', '"i2"'), refresh))?.name, fresh.name);
  calls = 0;
  assert.equal(await sw.matching(file('index v3', '"i3"'), refresh), undefined);
  assert.equal(calls, 2, 'two tries at most');
});

test('offline: the set\'s offline page, else a plain 503', async () => {
  const store = fakeStore();
  assert.equal((await sw.offlinePage(undefined)).status, 503);
  const shell = await completeSet(store, 100, { [sw.OFFLINE]: file('offline page') });
  assert.equal(await (await sw.offlinePage(shell)).text(), 'offline page');
});

test('an app file comes from its page\'s set, else the network, else the newest set', async () => {
  const store = fakeStore();
  const pinned = await completeSet(store, 100, { '/main.ts': file('main v1') });
  const newest = await completeSet(store, 200, { '/main.ts': file('main v2'), '/push.ts': file('push v2') });
  const request = (path: string): Request => new Request(`http://app${path}`);
  const network = (): Promise<Response> => Promise.resolve(file('from network'));
  const down = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
  assert.equal(await (await sw.fromSet(pinned, request('/main.ts'), down, () => Promise.resolve(newest))).text(), 'main v1');
  assert.equal(await (await sw.fromSet(pinned, request('/push.ts'), network, () => Promise.resolve(newest))).text(), 'from network');
  assert.equal(await (await sw.fromSet(null, request('/push.ts'), down, () => Promise.resolve(newest))).text(), 'push v2');
  await assert.rejects(sw.fromSet(null, request('/nope.ts'), down, () => Promise.resolve(newest)), /Failed to fetch/);
  // A set deleted under the page answers nothing: the network then.
  const deleted = { name: pinned.name, cache: { ...fakeCache(), match: () => Promise.reject(new Error('gone')) } };
  assert.equal(await (await sw.fromSet(deleted, request('/main.ts'), network, () => Promise.resolve(undefined))).text(), 'from network');
});
