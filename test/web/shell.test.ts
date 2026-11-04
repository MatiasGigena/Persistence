// The service worker caches the app shell for offline starts: its list must name every file the app loads.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAIR_CODE_MS } from '../../src/server/auth.ts';

const WEB = fileURLToPath(new URL('../../src/web/', import.meta.url));

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])));
  return nested.flat();
}

/** Runtime imports (not `import type`) of the web sources, as URLs. */
async function importedUrls(paths: readonly string[]): Promise<Set<string>> {
  const urls = new Set<string>();
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    for (const [, spec = ''] of text.matchAll(/^import (?!type )[^;]*? from '([^']+)';/gm)) {
      if (!spec.startsWith('.')) { urls.add(`/vendor/${spec}.esm.js`); continue; }
      const url = new URL(spec, `http://app/${relative(WEB, path)}`).pathname;
      urls.add(url);
    }
  }
  return urls;
}

test('the service worker shell lists every app file and runtime import', async () => {
  const sw = await readFile(join(WEB, 'sw.ts'), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const shell = new Set([...block.matchAll(/'([^']+)'/g)].map(([, path = '']) => path));
  if (block.includes('OFFLINE')) shell.add('/offline.html');
  // The worker's own scripts (sw.ts, and sw/ that it loads with importScripts) are not the page's.
  const all = (await files(WEB)).filter(path => !path.endsWith('sw.ts') && !relative(WEB, path).startsWith('sw/'));
  const served = all.filter(path => !path.endsWith('tsconfig.json') && !path.endsWith('index.html'))
    .map(path => `/${relative(WEB, path)}`);
  const sources = all.filter(path => path.endsWith('.ts'));
  const needed = new Set([...served, ...await importedUrls(sources), '/']);
  // Protocol files import each other; follow one level.
  for (const url of [...needed].filter(u => u.startsWith('/protocol/'))) {
    for (const nested of await importedUrls([fileURLToPath(new URL(`../../src${url}`, import.meta.url))])) needed.add(nested.replace(/^\/protocol\/\.\.\//, '/'));
  }
  const missing = [...needed].filter(url => !shell.has(url));
  assert.deepEqual(missing, []);
  const extra = [...shell].filter(url => !needed.has(url));
  assert.deepEqual(extra, [], 'the shell names only real files');
});

test('index.html preloads every module the app loads at startup, after the import map', async () => {
  const sw = await readFile(join(WEB, 'sw.ts'), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const modules = [...block.matchAll(/'([^']+\.(?:ts|js))'/g)].map(([, path = '']) => path);
  assert.ok(modules.includes('/main.ts'));
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const preloads = [...head.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(([, href = '']) => href);
  // The shell test above holds SHELL to the real files and runtime imports; main.ts is the module script itself.
  assert.ok(head.includes('<script type="module" src="/main.ts"></script>'));
  assert.deepEqual([...preloads].sort(), modules.filter(path => path !== '/main.ts').sort());
  assert.equal(new Set(preloads).size, preloads.length, 'no module is preloaded twice');
  const firstPreload = head.indexOf('rel="modulepreload"');
  assert.ok(head.indexOf('type="importmap"') < firstPreload, 'the import map comes before any module is fetched');
  assert.ok(firstPreload < head.indexOf('type="module"'));
});

test('the installed app and offline page share the dark theme', async () => {
  const css = await readFile(join(WEB, 'styles.css'), 'utf8');
  assert.match(css, /color-scheme: dark;/);
  assert.match(css, /--bg: #000000;/);
  assert.match(css, /--mono: ui-monospace/);
  assert.ok(!css.includes('prefers-color-scheme: dark'), 'the theme does not depend on the OS setting');
  for (const file of ['index.html', 'offline.html']) {
    const html = await readFile(join(WEB, file), 'utf8');
    assert.match(html, /<meta name="color-scheme" content="dark">/);
    assert.match(html, /<meta name="theme-color" content="#000000">/);
  }
  const manifest = await readFile(join(WEB, 'manifest.webmanifest'), 'utf8');
  assert.match(manifest, /"theme_color": "#000000"/);
  assert.match(manifest, /"background_color": "#000000"/);
});

test('bold and italic still show where the monospace font has only a regular face', async () => {
  // Android's monospace (and many a desktop's) ships one face: forbidding synthesis made **bold**, *em* and headings
  // plain text there.
  const css = await readFile(join(WEB, 'styles.css'), 'utf8');
  for (const [, value = ''] of css.matchAll(/font-synthesis:\s*([^;]+);/g)) {
    assert.match(value, /\bweight\b/, `font-synthesis: ${value} drops synthetic bold`);
    assert.match(value, /\bstyle\b/, `font-synthesis: ${value} drops synthetic italic`);
  }
});

test('code and output never show ligatures, under any font shorthand', async () => {
  // `font: …` resets font-variant-ligatures, so a value inherited from the root was lost on body, .prose and the tool
  // blocks, and `-rw-r--r--` read as `-rw-r—r—` in a font with ligatures (JetBrains Mono, Fira Code).
  const css = await readFile(join(WEB, 'styles.css'), 'utf8');
  assert.ok(/\bfont:\s/.test(css), 'the sheet uses the shorthand');
  assert.match(css, /^\*, \*::before, \*::after \{[^}]*font-variant-ligatures: none !important;/m);
});

test('the pairing screen states how long a code lasts as the server does', async () => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const minutes = /A code works once, for (\d+) minutes\./.exec(html)?.[1];
  assert.equal(Number(minutes), PAIR_CODE_MS / 60_000);
});
