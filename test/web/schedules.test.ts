// The Schedules sheet in Chromium: rows from the status, a cancel that waits for its answer, a refusal shown in the
// sheet, and no sideways overflow on a phone. Skipped where there is no Chromium.
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

/** index.html's sheet, the real Store and schedules panel, and a link whose schedule.cancel answers when the test says. */
async function probePage(): Promise<string> {
  const index = await readFile(fileURLToPath(new URL('../../src/web/index.html', import.meta.url)), 'utf8');
  const dialog = /<dialog id="sheet"[\s\S]*?<\/dialog>/.exec(index)?.[0] ?? assert.fail('index.html has no sheet');
  return `<!doctype html><html><head><link rel="stylesheet" href="/styles.css">
<script type="importmap">{"imports":{"marked":"/vendor/marked.esm.js"}}</script></head><body>${dialog}
<script type="module">
import { Sheet } from '/panels/sheet.ts';
import { Store } from '/store.ts';
import { schedulesView } from '/panels/schedules.ts';
const store = new Store();
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
const base = { model: 'p/m', thinkingLevel: 'high', toolsEnabled: false, busy: false, queued: 0, memory: undefined, agents: [] };
window.setSchedules = schedules => store.handle({ t: 'status', status: { ...base, schedules } });
window.setSchedules([
  { id: 3, text: 'Check whether the deploy to production finished and tell the user what the health checks say about it.', at: tomorrow.getTime() },
  { id: 4, text: 'Morning summary.', at: tomorrow.getTime(), cron: '0 9 * * 1-5' },
]);
let answer;
window.asked = [];
window.notices = [];
const link = { state: 'ready', request(op, params) {
  window.asked.push(op + ' ' + JSON.stringify(params));
  return new Promise((resolve, reject) => { answer = { resolve, reject }; });
} };
const sheet = new Sheet(document.getElementById('sheet'));
window.openSchedules = () => sheet.open(schedulesView({ store, link, sheet, notice(text) { window.notices.push(text); } }));
window.answer = () => answer.resolve(null);
window.fail = message => answer.reject(new Error(message));
window.ready = true;
</script></body></html>`;
}

describe('the Schedules sheet', { skip }, () => {
  let browser: Browser;
  let page: Page;
  let origin = '';
  const server = createServer();

  before(async () => {
    const html = await probePage();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  const open = async (width: number): Promise<void> => {
    page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/probe.html`);
    await page.waitForFunction('window.ready === true');
    await page.evaluate('window.openSchedules()');
    await page.waitForSelector('#sheet[open] .schedule-row');
  };
  const rows = (): Promise<unknown> => page.evaluate(`[...document.querySelectorAll('.schedule-row')].map(row => ({
    label: row.querySelector('.row-label').textContent, detail: row.querySelector('.row-detail').textContent,
    disabled: row.querySelector('button').disabled }))`);

  test('rows show each schedule\'s text and time; Cancel waits for its answer, then the row leaves with the status', async () => {
    await open(390);
    assert.deepEqual(await rows(), [
      { label: 'Check whether the deploy to production finished and tell the user what the health checks say about it.', detail: '#3 · tomorrow 09:00', disabled: false },
      { label: 'Morning summary.', detail: '#4 · cron 0 9 * * 1-5 · next tomorrow 09:00', disabled: false },
    ]);
    await page.click('button[aria-label="Cancel schedule 3"]');
    assert.deepEqual(((await rows()) as { disabled: boolean }[]).map(row => row.disabled), [true, false], 'only the cancelled row waits');
    await page.click('button[aria-label="Cancel schedule 3"]', { force: true }).catch(() => undefined);
    assert.deepEqual(await page.evaluate('window.asked'), ['schedule.cancel {"id":3}'], 'asked once');
    await page.evaluate('window.answer()');
    await page.waitForFunction('window.notices.length === 1');
    assert.deepEqual(await page.evaluate('window.notices'), ['Schedule #3 cancelled.']);
    await page.evaluate(`window.setSchedules([{ id: 4, text: 'Morning summary.', at: Date.now() + 3600000, cron: '0 9 * * 1-5' }])`);
    await page.waitForFunction(`document.querySelectorAll('.schedule-row').length === 1`);
    await page.evaluate('window.setSchedules([])');
    await page.waitForFunction(`document.querySelectorAll('.schedule-row').length === 0`);
    assert.match(await page.evaluate(`[...document.querySelectorAll('#sheet .sheet-note')].filter(n => !n.hidden).map(n => n.textContent).join('|')`) as string,
      /^No schedules\. Ask Pi to remind you of something/);
    await page.close();
  });

  test('a refused cancel says why in the sheet and gives the button back', async () => {
    await open(390);
    await page.click('button[aria-label="Cancel schedule 4"]');
    await page.evaluate(`window.fail('No schedule #4.')`);
    await page.waitForSelector('#sheet .sheet-note.is-error');
    assert.equal(await page.evaluate(`document.querySelector('#sheet .sheet-note.is-error').textContent`), 'Not cancelled: No schedule #4.');
    assert.deepEqual(((await rows()) as { disabled: boolean }[]).map(row => row.disabled), [false, false]);
    assert.deepEqual(await page.evaluate('window.notices'), []);
    await page.close();
  });

  for (const width of [320, 390, 1440]) {
    test(`at ${width}px a long text wraps inside the sheet and its Cancel button stays whole`, async () => {
      await open(width);
      const box = await page.evaluate(`(() => {
        const sheet = document.getElementById('sheet').getBoundingClientRect();
        const row = document.querySelector('.schedule-row');
        const button = row.querySelector('button').getBoundingClientRect(), label = row.querySelector('.row-label').getBoundingClientRect();
        return { inside: button.right <= sheet.right + 0.5 && label.left >= sheet.left - 0.5, apart: label.right <= button.left + 0.5,
          tap: button.height >= 44, scrolls: document.getElementById('sheet-body').scrollWidth > document.getElementById('sheet-body').clientWidth };
      })()`);
      assert.deepEqual(box, { inside: true, apart: true, tap: true, scrolls: false });
      await page.close();
    });
  }
});
