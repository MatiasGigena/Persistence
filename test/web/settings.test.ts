// Chat settings in Chromium: the selects fill from the link's lists, a choice sends model.set or thinking.set, and the
// tools switch asks first and sends tools.set with its confirmation. Skipped where there is no Chromium.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createStaticFiles } from '../../src/server/static.ts';

const executable = process.env.PI_DURABLE_CHROMIUM || chromium.executablePath();
const skip = existsSync(executable) ? false : `no Chromium at ${executable}`;

/** index.html's sheet and tools dialog, the real Store and settings panel, and a link that records each request. */
async function probePage(): Promise<string> {
  const index = await readFile(fileURLToPath(new URL('../../src/web/index.html', import.meta.url)), 'utf8');
  const dialog = (id: string): string => new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`).exec(index)?.[0] ?? assert.fail(`index.html has no ${id}`);
  return `<!doctype html><html><head><link rel="stylesheet" href="/styles.css">
<script type="importmap">{"imports":{"marked":"/vendor/marked.esm.js"}}</script></head><body>${dialog('sheet')}${dialog('tools-confirm')}
<script type="module">
import { Sheet } from '/panels/sheet.ts';
import { Store } from '/store.ts';
import { chatSettingsView } from '/panels/chat-settings.ts';
const store = new Store();
const status = { model: 'faux/a', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [] };
store.handle({ t: 'status', status });
window.sent = [];
const link = { state: 'ready', request(op, params) {
  window.sent.push([op, params]);
  if (op === 'models') return Promise.resolve({ models: [
    { provider: 'faux', id: 'a', name: 'Faux A', available: true },
    { provider: 'faux', id: 'b', name: 'Faux B', available: true },
    { provider: 'cloud', id: 'big', name: 'Cloud Big', available: false, note: 'needs CLOUD_KEY' }] });
  if (op === 'thinking.levels') return Promise.resolve({ levels: ['low', 'medium', 'high'] });
  if (op === 'model.set') { store.handle({ t: 'status', status: { ...status, model: params.provider + '/' + params.id } }); return Promise.resolve(null); }
  if (op === 'thinking.set') return Promise.resolve(null);
  if (op === 'tools.set') { store.handle({ t: 'status', status: { ...status, toolsEnabled: params.enabled } }); return Promise.resolve(null); }
  return Promise.reject(new Error('unexpected ' + op));
} };
window.notices = [];
const sheet = new Sheet(document.getElementById('sheet'));
window.openSettings = () => sheet.open(chatSettingsView({ store, link, sheet, notice: text => window.notices.push(text) }));
window.ready = true;
</script></body></html>`;
}

describe('chat settings', { skip }, () => {
  let browser: Browser;
  let page: Page;
  let origin = '';
  const server = createServer();

  before(async () => {
    const html = await probePage();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const files = await createStaticFiles(origin);
    server.on('request', (request, response) => {
      const { pathname } = new URL(request.url ?? '/', origin);
      if (pathname === '/probe.html') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      else void files.serve(request, response, pathname);
    });
    browser = await chromium.launch({ executablePath: executable });
  });
  after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  const open = async (): Promise<void> => {
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/probe.html`);
    await page.waitForFunction('window.ready === true');
    await page.evaluate('window.openSettings()');
    await page.waitForSelector('#sheet[open] .control-select:not([hidden])');
  };
  const sent = (op: string): Promise<unknown[]> => page.evaluate(`window.sent.filter(([o]) => o === ${JSON.stringify(op)}).map(([, p]) => p)`);
  const selects = 'document.querySelectorAll("#sheet .control-select")';

  test('the selects list the models and levels, a model without credentials disabled', async () => {
    await open();
    await page.waitForFunction(`${selects}[1].options.length === 3`);
    const shown: unknown = await page.evaluate(`[...${selects}].map(s => ({ value: s.value,
      options: [...s.options].map(o => [o.value, o.textContent, o.disabled]) }))`);
    assert.deepEqual(shown, [
      { value: 'faux/a', options: [['faux/a', 'Faux A', false], ['faux/b', 'Faux B', false], ['cloud/big', 'Cloud Big (needs CLOUD_KEY)', true]] },
      { value: 'high', options: [['low', 'low · Quick answers', false], ['medium', 'medium · Balanced', false], ['high', 'high · The default', false]] },
    ]);
    await page.close();
  });

  test('choosing a model or a level sends it and says so', async () => {
    await open();
    await page.waitForFunction(`${selects}[1].options.length === 3`);
    await page.selectOption('#sheet .control >> nth=0 >> select', 'faux/b');
    await page.waitForFunction('window.notices.some(n => n.startsWith("Model: faux/b"))');
    assert.deepEqual(await sent('model.set'), [{ provider: 'faux', id: 'b' }]);
    await page.waitForFunction(`!${selects}[1].disabled`);
    await page.selectOption('#sheet .control >> nth=1 >> select', 'low');
    await page.waitForFunction('window.notices.some(n => n.startsWith("Effort: low"))');
    assert.deepEqual(await sent('thinking.set'), [{ level: 'low' }]);
    await page.close();
  });

  test('the tools switch asks first; Cancel sends nothing, and Turn on sends the confirmation', async () => {
    await open();
    const toggle = page.getByRole('switch', { name: 'Coding tools' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.waitForSelector('#tools-confirm[open]');
    await page.click('#tools-confirm button[value="cancel"]');
    await page.waitForFunction('window.notices.includes("Coding tools stay off.")');
    assert.deepEqual(await sent('tools.set'), []);
    await toggle.click();
    await page.waitForSelector('#tools-confirm[open]');
    await page.click('#tools-confirm button[value="enable"]');
    await page.waitForFunction('document.querySelector("#sheet [role=switch]").getAttribute("aria-checked") === "true"');
    assert.deepEqual(await sent('tools.set'), [{ enabled: true, confirm: 'enable-tools' }]);
    await page.close();
  });
});
