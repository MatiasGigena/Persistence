import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, test } from 'node:test';
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from '@earendil-works/chord/context';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type ConversationId, ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { chromium } from 'playwright-core';
import {
  type BrowserExtension, type BrowserOptions, createBrowserExtension, evalSource, filterHeaders, httpUrl, KEEP_HEADERS,
} from '../../src/tools/browser.ts';

const TOOLS = [
  'browser_goto', 'browser_eval', 'browser_console', 'browser_network', 'browser_fill', 'browser_click',
  'browser_screenshot', 'browser_close',
];

// The tools read only `conversationId` from their api.
const apiFor = (conversationId: ConversationId) => ({ conversationId }) as unknown as ToolExecutionApi;

function caller(extension: BrowserExtension, conversationId: ConversationId = ROOT_CONVERSATION_ID) {
  return (name: string, args: object = {}, context: Context = BACKGROUND_CONTEXT): Promise<ToolExecutionResult> => {
    const tool = extension.tools.find((t) => t.name === name);
    assert.ok(tool, name);
    return tool.execute(args, apiFor(conversationId), context);
  };
}

const textOf = (result: ToolExecutionResult): string =>
  (result.output ?? []).filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('\n');

describe('browser helpers', () => {
  test('filterHeaders keeps allowed headers and redacts secrets', () => {
    const headers = {
      Authorization: 'Bearer x', Cookie: 'a=b', 'X-Api-Key': 'k', 'x-auth-token': 't', 'Content-Type': 'text/html', Accept: '*/*',
    };
    assert.deepEqual(filterHeaders(headers, KEEP_HEADERS), { Authorization: '[redacted]', 'Content-Type': 'text/html' });
    assert.deepEqual(filterHeaders(headers, new Set([...KEEP_HEADERS, 'cookie', 'x-api-key', 'x-auth-token', 'accept'])), {
      Authorization: '[redacted]', Cookie: '[redacted]', 'X-Api-Key': '[redacted]', 'x-auth-token': '[redacted]',
      'Content-Type': 'text/html', Accept: '*/*',
    });
  });

  test('httpUrl allows http(s), loopback included, and refuses the rest', () => {
    assert.equal(httpUrl('http://127.0.0.1:3000/x').href, 'http://127.0.0.1:3000/x');
    assert.equal(httpUrl('https://10.0.0.1/').protocol, 'https:');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings']) {
      assert.throws(() => httpUrl(url), /Only HTTP\(S\)/);
    }
    assert.throws(() => httpUrl('not a url'), /Invalid URL/);
  });

  test('evalSource handles expressions, functions and IIFEs', () => {
    assert.equal(runInNewContext(evalSource('1 + 2')), 3);
    assert.equal(runInNewContext(evalSource('() => 42')), 42);
    assert.equal(runInNewContext(evalSource('(() => 7)()')), 7);
    assert.equal(runInNewContext(evalSource('function () { return "f"; }')), 'f');
  });

  test('extension names and tools', () => {
    const extension = createBrowserExtension({ profileRoot: tmpdir() });
    assert.equal(extension.name, 'browser');
    assert.deepEqual(extension.tools.map((t) => t.name), TOOLS);
    assert.ok(extension.tools.every((t) => t.executionMode === 'sequential'));
  });

  test('a non-http URL is refused without launching', async () => {
    let launched = false;
    const extension = createBrowserExtension({
      profileRoot: tmpdir(), launch: () => { launched = true; return Promise.reject(new Error('no launch')); },
    });
    await assert.rejects(caller(extension)('browser_goto', { url: 'file:///etc/passwd' }), /Only HTTP\(S\)/);
    assert.equal(launched, false);
  });

  test('an operation times out, and an abort cancels it', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-durable-browser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hang: BrowserOptions['launch'] = () => new Promise(() => undefined);
    const call = caller(createBrowserExtension({ profileRoot: root, launch: hang, timeoutMs: 50 }));
    await assert.rejects(call('browser_eval', { expression: '1' }), /timed out/);
    const controller = new AbortController();
    const slow = caller(createBrowserExtension({ profileRoot: root, launch: hang }));
    const pending = slow('browser_eval', { expression: '1' }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  });
});

const executable = process.env.PI_DURABLE_CHROMIUM;
const skip = !executable ? 'PI_DURABLE_CHROMIUM is unset' : !existsSync(executable) ? `no Chromium at ${executable}` : false;

const PAGE = `<!doctype html><html><body>
<input id="name"><button id="go" onclick="document.getElementById('out').textContent = 'Hi ' + document.getElementById('name').value">Go</button>
<p id="out"></p>
<script>
  console.log('hello from page');
  setTimeout(() => { throw new Error('boom'); }, 0);
  fetch('/api', { headers: { Authorization: 'Bearer secret123' } }).then((r) => r.text());
</script></body></html>`;

describe('browser tools in Chromium', { skip }, () => {
  let server: Server;
  let base = '';
  let root = '';
  let extension: BrowserExtension;
  let call: ReturnType<typeof caller>;

  test.before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: '/' }).end(); return; }
      if (req.url === '/api') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
      if (req.url === '/missing') { res.writeHead(404).end('nope'); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), 'pi-durable-browser-'));
    extension = createBrowserExtension({
      profileRoot: root,
      ...(executable ? { executablePath: executable } : {}),
      // Chromium refuses its sandbox when run as root, as in CI containers; elsewhere the extension's options stand.
      launch: (dir, options) => chromium.launchPersistentContext(dir, process.getuid?.() === 0 ? { ...options, chromiumSandbox: false } : options),
    });
    call = caller(extension);
  });

  test.after(async () => {
    await extension.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  test('goto reports the status and the final URL', async () => {
    const result = await call('browser_goto', { url: `${base}/redirect` });
    assert.equal(textOf(result), `200 ${base}/`);
    assert.deepEqual(result.details, { status: 200, finalUrl: `${base}/` });
    assert.equal(textOf(await call('browser_goto', { url: `${base}/missing` })), `404 ${base}/missing`);
    await assert.rejects(call('browser_goto', { url: 'file:///etc/passwd' }), /Only HTTP\(S\)/);
    assert.ok((await stat(join(root, 'browser', String(ROOT_CONVERSATION_ID)))).isDirectory());
  });

  test('eval takes expressions, functions and IIFEs', async () => {
    await call('browser_goto', { url: `${base}/`, waitUntil: 'load' });
    assert.equal(textOf(await call('browser_eval', { expression: 'document.title.length + 1' })), '1');
    assert.equal(textOf(await call('browser_eval', { expression: '() => location.pathname' })), '/');
    assert.equal(textOf(await call('browser_eval', { expression: 'async () => ({ a: 1 })' })), '{\n  "a": 1\n}');
    assert.equal(textOf(await call('browser_eval', { expression: '(() => 42)()' })), '42');
    const failed = await call('browser_eval', { expression: 'nope.nope' });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /^eval error: .*nope/);
  });

  test('fill and click change the DOM', async () => {
    await call('browser_goto', { url: `${base}/` });
    assert.equal(textOf(await call('browser_fill', { selector: '#name', value: 'Ada' })), 'filled #name');
    assert.equal(textOf(await call('browser_click', { selector: 'text=Go' })), 'clicked text=Go');
    assert.equal(textOf(await call('browser_eval', { expression: "document.getElementById('out').textContent" })), 'Hi Ada');
  });

  test('console captures logs and page errors, and drains', async () => {
    await call('browser_console');
    await call('browser_goto', { url: `${base}/`, waitUntil: 'load' });
    await call('browser_eval', { expression: 'new Promise((r) => setTimeout(r, 100))' });
    const peek = textOf(await call('browser_console', { clear: false }));
    assert.match(peek, /log: hello from page/);
    assert.match(peek, /pageerror: Error: boom/);
    assert.match(textOf(await call('browser_console', { filter: 'boom' })), /boom/);
    assert.equal(textOf(await call('browser_console')), '(empty)');
  });

  test('network lists requests with redacted authorization', async () => {
    await call('browser_network');
    await call('browser_goto', { url: `${base}/`, waitUntil: 'load' });
    await call('browser_eval', { expression: 'new Promise((r) => setTimeout(r, 200))' });
    const terse = textOf(await call('browser_network', { clear: false, urlFilter: '/api' }));
    assert.equal(terse, `200 GET ${base}/api`);
    const verbose = textOf(await call('browser_network', { urlFilter: '/api', verbose: true }));
    assert.match(verbose, /→ authorization: \[redacted\]/);
    assert.match(verbose, /← content-type: application\/json/);
    assert.doesNotMatch(verbose, /secret123/);
    assert.equal(textOf(await call('browser_network')), '(empty)');
  });

  test('screenshot returns a PNG image', async () => {
    await call('browser_goto', { url: `${base}/` });
    for (const fullPage of [false, true]) {
      const result = await call('browser_screenshot', { fullPage });
      const image = (result.output ?? []).find((c): c is ImageContent => c.type === 'image');
      assert.ok(image);
      assert.equal(image.mimeType, 'image/png');
      assert.deepEqual([...Buffer.from(image.data, 'base64').subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });

  test('the queue serializes concurrent calls', async () => {
    await call('browser_goto', { url: `${base}/` });
    const [first, second] = await Promise.all([
      call('browser_eval', { expression: 'async () => { window.x = 1; await new Promise((r) => setTimeout(r, 300)); return window.x; }' }),
      call('browser_eval', { expression: '() => { window.x = 2; return window.x; }' }),
    ]);
    assert.equal(textOf(first), '1');
    assert.equal(textOf(second), '2');
  });

  test('each conversation has its own profile, and close relaunches', async () => {
    await call('browser_goto', { url: `${base}/` });
    await call('browser_eval', { expression: "localStorage.setItem('who', 'pi')" });
    const other = caller(extension, 2 as ConversationId);
    await other('browser_goto', { url: `${base}/` });
    assert.equal(textOf(await other('browser_eval', { expression: "localStorage.getItem('who')" })), 'null');
    assert.equal(textOf(await other('browser_close')), 'browser closed');
    assert.ok((await stat(join(root, 'browser', '2'))).isDirectory());
    assert.equal(textOf(await call('browser_close')), 'browser closed');
    await call('browser_goto', { url: `${base}/` });
    assert.equal(textOf(await call('browser_eval', { expression: "localStorage.getItem('who')" })), 'pi');
  });
});
