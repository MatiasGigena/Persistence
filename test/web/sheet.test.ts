// The sheet in Chromium: focus never falls out of it when a level is pushed or gone back from. Runs with Playwright's
// Chromium (or PI_DURABLE_CHROMIUM); skipped where there is none.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createStaticFiles } from '../../src/server/static.ts';

const executable = process.env.PI_DURABLE_CHROMIUM || chromium.executablePath();
const skip = existsSync(executable) ? false : `no Chromium at ${executable}`;

/** A page with index.html's sheet, driven by the real sheet.ts: Open shows a level whose buttons each push one. */
async function probePage(): Promise<string> {
  const index = await readFile(fileURLToPath(new URL('../../src/web/index.html', import.meta.url)), 'utf8');
  const dialog = /<dialog id="sheet"[\s\S]*?<\/dialog>/.exec(index)?.[0] ?? assert.fail('index.html has no sheet');
  return `<!doctype html><html><head><link rel="stylesheet" href="/styles.css">
<script type="importmap">{"imports":{"marked":"/vendor/marked.esm.js"}}</script></head><body>
<button id="opener">Open</button>${dialog}
<script type="module">
import { Sheet } from '/panels/sheet.ts';
const sheet = new Sheet(document.getElementById('sheet'));
/** A level with one button per name; each pushes a level of that name. */
const level = (title, names) => ({ title, render(body) {
  for (const name of names) {
    const button = document.createElement('button');
    button.className = 'go';
    button.textContent = name;
    button.addEventListener('click', () => sheet.push(level(name, [])));
    body.append(button);
  }
} });
document.getElementById('opener').addEventListener('click', () => sheet.open(level('Settings', ['Agents', 'Memory'])));
window.ready = true;
</script></body></html>`;
}

describe('the sheet keeps focus in place', { skip }, () => {
  let browser: Browser;
  let page: Page;
  const server = createServer();

  before(async () => {
    const html = await probePage();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const files = await createStaticFiles(origin);
    server.on('request', (request, response) => {
      const { pathname } = new URL(request.url ?? '/', origin);
      if (pathname === '/probe.html') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      else void files.serve(request, response, pathname);
    });
    browser = await chromium.launch({ executablePath: executable });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/probe.html`);
    await page.waitForFunction('window.ready === true');
  });
  after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  /** The focused element, as `tag#id text`. Strings, as the tests have no DOM types. */
  const focused = async (): Promise<string> => {
    const at: unknown = await page.evaluate(`(() => { const at = document.activeElement;
      return at ? at.tagName.toLowerCase() + (at.id ? '#' + at.id : '') + ' ' + at.textContent.trim() : 'none'; })()`);
    return String(at);
  };
  const titled = (title: string): Promise<unknown> => page.waitForFunction(`document.getElementById('sheet-title').textContent === ${JSON.stringify(title)}`);

  test('a pushed level takes focus on its title, and going back returns it to the row that pushed it', async () => {
    await page.focus('#opener');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet[open]');
    await page.focus('.go:nth-of-type(2)');
    await page.keyboard.press('Enter');
    await titled('Memory');
    assert.equal(await focused(), 'h2#sheet-title Memory');
    // Escape goes up one level.
    await page.keyboard.press('Escape');
    await titled('Settings');
    assert.equal(await focused(), 'button Memory');
    // So does a breadcrumb.
    await page.keyboard.press('Enter');
    await titled('Memory');
    await page.focus('.crumb');
    await page.keyboard.press('Enter');
    await titled('Settings');
    assert.equal(await focused(), 'button Memory');
  });
});
