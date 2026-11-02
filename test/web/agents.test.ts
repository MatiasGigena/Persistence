// An agent's conversation in Chromium: its skeleton holds until the snapshot (an empty one included), gives way to an
// error, and the Stop bar keeps clear of the conversation's rule. Skipped where there is no Chromium.
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

/** index.html's sheet, the real Store and agents panel, and a link whose feed.open answers when the test says. */
async function probePage(): Promise<string> {
  const index = await readFile(fileURLToPath(new URL('../../src/web/index.html', import.meta.url)), 'utf8');
  const dialog = /<dialog id="sheet"[\s\S]*?<\/dialog>/.exec(index)?.[0] ?? assert.fail('index.html has no sheet');
  return `<!doctype html><html><head><link rel="stylesheet" href="/styles.css">
<script type="importmap">{"imports":{"marked":"/vendor/marked.esm.js"}}</script></head><body>${dialog}
<script type="module">
import { Sheet } from '/panels/sheet.ts';
import { Store } from '/store.ts';
import { agentChatView } from '/panels/agents.ts';
const store = new Store();
store.handle({ t: 'status', status: { model: 'p/m', thinkingLevel: 'high', toolsEnabled: false, busy: true, queued: 0,
  memory: undefined, agents: [{ name: 'Coder', role: 'main', parent: 'Pi', busy: true }] } });
let answer;
const link = { state: 'ready', request(op) {
  if (op === 'feed.open') return new Promise((resolve, reject) => { answer = { resolve, reject }; });
  return Promise.resolve({ names: [] });
} };
const sheet = new Sheet(document.getElementById('sheet'));
window.openAgent = () => sheet.open(agentChatView({ store, link, sheet, notice() {} }, 'Coder'));
window.closeSheet = () => sheet.close();
window.answer = feed => answer.resolve({ feed });
window.fail = () => answer.reject(new Error('No agent named Coder.'));
window.snapshot = (feed, items) => store.handle({ t: 'snapshot', feed, items });
window.opens = 0;
const request = link.request;
link.request = op => { if (op === 'feed.open') window.opens++; return request(op); };
// A drop before the snapshot, then main.ts's reopen after ready failing: it forgets the detached feed.
window.dropAndLoseReopen = () => { store.disconnect(); store.forget('Coder'); };
window.ready = true;
</script></body></html>`;
}

describe('an agent conversation loads under the loading rule', { skip }, () => {
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
    await page.evaluate('window.openAgent()');
    await page.waitForSelector('#sheet[open] .agent-chat');
  };
  const shown = (): Promise<unknown> => page.evaluate(`(() => ({
    skeleton: Boolean(document.querySelector('.agent-chat .feed-skeleton')),
    list: !document.querySelector('.feed-agent').hidden,
    empty: Boolean(document.querySelector('.feed-agent .empty')?.checkVisibility()),
    note: document.querySelector('.sheet-actions .sheet-note').textContent,
  }))()`);

  test('the skeleton stays past the feed.open answer until the snapshot, an empty one included', async () => {
    await open(390);
    assert.deepEqual(await shown(), { skeleton: true, list: false, empty: false, note: 'Working' });
    assert.equal(await page.evaluate(`document.querySelector('.feed-skeleton').getAttribute('aria-busy')`), 'true');
    await page.evaluate(`window.answer('f1')`);
    await page.waitForTimeout(100);
    assert.deepEqual(await shown(), { skeleton: true, list: false, empty: false, note: 'Working' }, 'no empty flash before the snapshot');
    await page.evaluate(`window.snapshot('f1', [])`);
    await page.waitForFunction(`Boolean(document.querySelector('.feed-agent .empty'))`);
    assert.deepEqual(await shown(), { skeleton: false, list: true, empty: true, note: 'Working' });
    await page.close();
  });

  test('a snapshot with items replaces the skeleton', async () => {
    await open(1440);
    await page.evaluate(`window.answer('f1')`);
    await page.evaluate(`window.snapshot('f1', [{ kind: 'user', id: 'u', text: 'task' }])`);
    await page.waitForSelector('.feed-agent .item');
    assert.deepEqual(await shown(), { skeleton: false, list: true, empty: false, note: 'Working' });
    await page.close();
  });

  test('a failed feed.open gives way to its error, never a skeleton left on', async () => {
    await open(390);
    await page.evaluate('window.fail()');
    await page.waitForFunction(`!document.querySelector('.agent-chat .feed-skeleton')`);
    assert.equal(((await shown()) as { note: string }).note, 'No agent named Coder.');
    await page.close();
  });

  test('a reopen that fails after a drop before the snapshot gives way to the error, never a skeleton left on', async () => {
    await open(390);
    await page.evaluate(`window.answer('f1')`);
    await page.evaluate('window.dropAndLoseReopen()');
    assert.equal(await page.evaluate('window.opens'), 2, 'the conversation is asked for again');
    await page.evaluate('window.fail()');
    await page.waitForFunction(`!document.querySelector('.agent-chat .feed-skeleton')`, undefined, { timeout: 2000 });
    assert.equal(((await shown()) as { note: string }).note, 'No agent named Coder.');
    await page.close();
  });

  test('a reopen that fails after a drop, then works when asked again, loads the conversation', async () => {
    await open(1440);
    await page.evaluate(`window.answer('f1')`);
    await page.evaluate('window.dropAndLoseReopen()');
    await page.evaluate(`window.answer('f2')`);
    await page.evaluate(`window.snapshot('f2', [{ kind: 'user', id: 'u', text: 'task' }])`);
    await page.waitForSelector('.feed-agent .item');
    assert.deepEqual(await shown(), { skeleton: false, list: true, empty: false, note: 'Working' });
    await page.close();
  });

  for (const width of [320, 390, 1440]) {
    test(`at ${width}px the Stop button keeps clear of the conversation's rule`, async () => {
      await open(width);
      const gap = await page.evaluate(`document.querySelector('.agent-chat').getBoundingClientRect().top
        - document.querySelector('.sheet-actions .btn').getBoundingClientRect().bottom`);
      assert.ok(Number(gap) >= 8, `only ${String(gap)}px between Stop and the rule`);
      await page.close();
    });
  }
});
