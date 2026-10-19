// The service worker caches the app shell for offline starts: its list must name every file the app loads.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const all = await files(WEB);
  const served = all.filter(path => !path.endsWith('tsconfig.json') && !path.endsWith('sw.ts') && !path.endsWith('index.html'))
    .map(path => `/${relative(WEB, path)}`);
  const sources = all.filter(path => path.endsWith('.ts') && !path.endsWith('sw.ts'));
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
