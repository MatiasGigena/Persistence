import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { assetsHash, contentSecurityPolicy, createStaticFiles, DEFAULT_ROOTS, importMapHashes, resolveFile } from '../../src/server/static.ts';
import type { StaticRoots } from '../../src/server/static.ts';

const ORIGIN = 'https://vps.tail1.ts.net';
const IMPORT_MAP = '{"imports":{"marked":"/vendor/marked.esm.js"}}';
const INDEX = `<!doctype html><title>t</title><script type="importmap">${IMPORT_MAP}</script><script type="module" src="/main.ts"></script>`;

/** A web app fixture: the four roots, with a secret beside them to escape to. */
async function fixture(t: TestContext): Promise<StaticRoots & { folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'pi-durable-static-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const roots = { folder, web: join(folder, 'web'), protocol: join(folder, 'protocol'), ui: join(folder, 'ui'), marked: join(folder, 'marked') };
  for (const dir of [roots.web, join(roots.web, 'panels'), roots.protocol, roots.ui, roots.marked]) await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(roots.web, 'index.html'), INDEX),
    writeFile(join(roots.web, 'main.ts'), "import type { X } from '../protocol/version.ts';\nconst n: number = 1;\nexport const x = (a: X): X => a;\n"),
    writeFile(join(roots.web, 'panels', 'a.ts'), 'export const a = 1 as number;\n'),
    writeFile(join(roots.web, 'styles.css'), 'body{}\n'),
    writeFile(join(roots.web, 'tsconfig.json'), '{}'),
    writeFile(join(roots.web, '.env'), 'SECRET=1'),
    writeFile(join(roots.web, 'run.sh'), 'echo hi'),
    writeFile(join(roots.web, 'enum.ts'), 'enum E { A }\n'),
    writeFile(join(roots.protocol, 'version.ts'), 'export type X = number;\nexport const PROTOCOL: number = 1;\n'),
    writeFile(join(roots.ui, 'types.ts'), 'export type Y = string;\n'),
    writeFile(join(roots.ui, 'text.ts'), 'export const z = 1 as number;\n'),
    writeFile(join(roots.marked, 'marked.esm.js'), 'export const marked = 1;\n'),
    writeFile(join(roots.marked, 'marked.umd.js'), 'nope'),
    writeFile(join(folder, 'secret.ts'), 'export const secret = 1;\n'),
  ]);
  await symlink(join(folder, 'secret.ts'), join(roots.web, 'link.ts'));
  return roots;
}

async function serve(t: TestContext, roots: StaticRoots): Promise<(path: string, headers?: IncomingHttpHeaders, method?: string) => Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>> {
  const files = await createStaticFiles(ORIGIN, roots);
  const server = createServer((req, res) => {
    files.serve(req, res, (req.url ?? '/').split('?', 1)[0] ?? '/').catch(() => res.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // http.request sends the path as given, unlike fetch, which would normalize the dot segments away.
  return (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path, headers, method }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
}

test('TypeScript is type-stripped to JavaScript; the shell and other files carry types, ETags and no-cache', async t => {
  const roots = await fixture(t);
  const get = await serve(t, roots);
  const main = await get('/main.ts');
  assert.equal(main.status, 200);
  assert.equal(main.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.ok(!main.body.includes(': number') && !main.body.includes('import type'), main.body);
  assert.match(main.body, /export const x = \(a\s*\)\s*=> a;/);
  assert.match((await get('/panels/a.ts')).body, /export const a = 1\s*;/);
  assert.match((await get('/protocol/version.ts')).body, /export const PROTOCOL\s*= 1;/);
  assert.match((await get('/ui/text.ts')).body, /export const z = 1\s*;/);
  assert.equal((await get('/ui/types.ts')).status, 404, 'only the listed ui files are served');
  assert.equal((await get('/vendor/marked.esm.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get('/styles.css')).headers['content-type'], 'text/css; charset=utf-8');

  const shell = await get('/');
  assert.equal(shell.status, 200);
  assert.equal(shell.body, INDEX);
  assert.equal(shell.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(shell.headers['cache-control'], 'no-cache');
  const etag = shell.headers.etag ?? '';
  assert.match(etag, /^"[\w-]+"$/);
  assert.equal((await get('/index.html', { 'if-none-match': etag })).status, 304);
  const head = await get('/', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  // A changed file is stripped again: the cache follows the mtime.
  await writeFile(join(roots.web, 'panels', 'a.ts'), 'export const a = 2 as number;\n');
  await utimes(join(roots.web, 'panels', 'a.ts'), new Date(), new Date(Date.now() + 5000));
  assert.match((await get('/panels/a.ts')).body, /export const a = 2\s*;/);
  assert.equal((await get('/enum.ts')).status, 500, 'non-erasable syntax is not served');
});

test('a strict CSP with the import map hash, and nosniff and no-referrer, on every response', async t => {
  const get = await serve(t, await fixture(t));
  const hash = createHash('sha256').update(IMPORT_MAP).digest('base64');
  assert.deepEqual(importMapHashes(INDEX), [`'sha256-${hash}'`]);
  for (const path of ['/', '/main.ts', '/missing.ts']) {
    const { headers } = await get(path);
    const csp = String(headers['content-security-policy'] ?? '');
    assert.match(csp, /default-src 'self'/);
    assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
    assert.ok(csp.includes(`connect-src 'self' wss://vps.tail1.ts.net`), csp);
    assert.ok(csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'"));
    assert.ok(!csp.includes('unsafe'), csp);
    assert.ok(csp.includes("img-src 'self' data:"), 'chat images are data: URLs (ADR 0031)');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
  }
  assert.ok(contentSecurityPolicy('http://localhost:7433', '').includes("connect-src 'self' ws://localhost:7433"));
  assert.ok(contentSecurityPolicy(ORIGIN, '').includes("script-src 'self';"), 'no hash without an import map');
});

test('traversal, symlinks out of a root, hidden files and unlisted extensions are 404', async t => {
  const roots = await fixture(t);
  const get = await serve(t, roots);
  for (const path of ['/../secret.ts', '/%2e%2e/secret.ts', '/..%2fsecret.ts', '/panels/../../secret.ts', '/protocol/../../secret.ts',
    '/protocol/%2e%2e%2fsecret.ts', '/link.ts', '/.env', '/tsconfig.json', '/run.sh', '/vendor/marked.umd.js', '/vendor/../secret.ts', '/ui/../secret.ts', '/ui/%2e%2e%2fsecret.ts',
    '/%00.ts', '/..\\secret.ts', '/%E0%A4%A.ts', '/panels/', '//etc/passwd', '/missing.ts']) {
    const { status, body } = await get(path);
    assert.equal(status, 404, path);
    assert.ok(!body.includes('secret'), path);
  }
  assert.equal(await resolveFile(roots, '/../secret.ts'), undefined);
  assert.equal(await resolveFile(roots, '/main.ts'), join(roots.web, 'main.ts'));
});

test('the assets hash covers every served file and changes with any of them', async t => {
  const roots = await fixture(t);
  const before = await assetsHash(roots);
  assert.match(before, /^[\w-]{16}$/);
  assert.equal(await assetsHash(roots), before);
  await writeFile(join(roots.protocol, 'version.ts'), 'export const PROTOCOL = 2;\n');
  const changed = await assetsHash(roots);
  assert.notEqual(changed, before);
  await writeFile(join(roots.web, 'run.sh'), 'echo changed');
  assert.equal(await assetsHash(roots), changed, 'unserved files do not count');
  await writeFile(join(roots.web, 'panels', 'b.ts'), 'export {};\n');
  assert.notEqual(await assetsHash(roots), changed);
  assert.match(await assetsHash(DEFAULT_ROOTS), /^[\w-]{16}$/, 'the real app hashes');
});
