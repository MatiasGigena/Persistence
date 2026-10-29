import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { describe, test } from 'node:test';
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from '@earendil-works/chord/context';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type ConversationId, ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { type BrowserContext, chromium } from 'playwright-core';
import {
  browserAddressRefusal, type BrowserExtension, type BrowserOptions, createBrowserExtension, egressRefusal, evalSource,
  filterHeaders, httpUrl, KEEP_HEADERS, redactLocation, redactText, redactUrl,
} from '../../src/tools/browser.ts';
import type { Lookup } from '../../src/tools/web-fetch.ts';

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

/** Test DNS: these names only, the rest do not resolve. */
const NAMES: Readonly<Record<string, string>> = {
  'metadata.test': '169.254.169.254', 'tailnet.test': '100.101.102.103', 'app.test': '10.0.0.5', 'public.test': '93.184.215.14',
  'v6.test': 'fd7a:115c:a1e0::5',
};
const lookup: Lookup = (host) => {
  const address = NAMES[host];
  return address ? Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
};
const LINK_LOCAL = 'Refused: 169.254.169.254 is a link-local address; the browser may not open it.';
const PUBLIC_REFUSED = 'Refused: public.test resolves to 93.184.215.14, a public address; this browser opens loopback and private addresses only.';

/** Poll `read` until it matches `pattern`, for events that arrive after the call that caused them. */
async function until(read: () => Promise<string>, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await read();
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) assert.fail(`no ${String(pattern)} within ${timeoutMs} ms in:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

  test('filterHeaders hides a location\'s query and fragment, and a referer\'s sensitive parameters', () => {
    const headers = { Location: 'https://app.test/cb?code=abc&state=xyz#access_token=tok', Referer: 'https://a.test/p?session=s1&page=2' };
    assert.deepEqual(filterHeaders(headers, new Set([...KEEP_HEADERS, 'referer'])), {
      Location: 'https://app.test/cb?[redacted]#[redacted]', Referer: 'https://a.test/p?session=[redacted]&page=2',
    });
    assert.equal(redactLocation('/'), '/');
    assert.equal(redactLocation('/next?x=1'), '/next?[redacted]');
  });

  test('redactUrl hides sensitive query and fragment values only', () => {
    assert.equal(redactUrl('http://h/x'), 'http://h/x');
    assert.equal(redactUrl('http://h/cb?code=abc&state=s&api_key=k&q=hi'), 'http://h/cb?code=[redacted]&state=s&api_key=[redacted]&q=hi');
    assert.equal(redactUrl('http://h/#access_token=t&token_type=bearer&x=1'), 'http://h/#access_token=[redacted]&token_type=[redacted]&x=1');
    assert.equal(redactUrl('http://h/?X-Amz-Signature=s&Password=p&flag'), 'http://h/?X-Amz-Signature=[redacted]&Password=[redacted]&flag');
    assert.equal(redactUrl('http://h/#section'), 'http://h/#section');
    assert.equal(redactUrl('https://user:p%40ss@h.test:8/x?sid=1&connect.sid=2&csrf_token=3&_xsrf=4&side=5&jsessionid=6'),
      'https://h.test:8/x?sid=[redacted]&connect.sid=[redacted]&csrf_token=[redacted]&_xsrf=[redacted]&side=5&jsessionid=[redacted]');
    assert.equal(redactLocation('http://a:b@h/cb?code=1'), 'http://h/cb?[redacted]');
  });

  test('filterHeaders redacts session, CSRF and XSRF headers', () => {
    const headers = { 'X-CSRF-Header': 'c', 'X-XSRF': 'x', 'X-Session-Id': 's', SID: 'i', 'X-Side': 'left' };
    assert.deepEqual(filterHeaders(headers, new Set(['x-csrf-header', 'x-xsrf', 'x-session-id', 'sid', 'x-side'])), {
      'X-CSRF-Header': '[redacted]', 'X-XSRF': '[redacted]', 'X-Session-Id': '[redacted]', SID: '[redacted]', 'X-Side': 'left',
    });
  });

  test('redactText hides JWTs and redacts URLs in console text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    assert.equal(redactText(`token ${jwt} expired`), 'token [redacted] expired');
    assert.equal(redactText('GET https://u:pw@api.test/v1?access_token=abc&page=2 failed (401)'),
      'GET https://api.test/v1?access_token=[redacted]&page=2 failed (401)');
    assert.equal(redactText('plain text, no secrets'), 'plain text, no secrets');
  });

  test('browserAddressRefusal: local always, public unless localOnly, metadata and tailnet never', () => {
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.20.0.1', '192.168.0.2', 'fd00::1']) {
      assert.equal(browserAddressRefusal(ip, false), undefined, ip);
      assert.equal(browserAddressRefusal(ip, true), undefined, ip);
    }
    assert.equal(browserAddressRefusal('8.8.8.8', false), undefined);
    assert.equal(browserAddressRefusal('8.8.8.8', true), 'a public');
    assert.equal(browserAddressRefusal('2606:4700::1111', true), 'a public');
    const never: readonly [string, string][] = [
      ['169.254.169.254', 'a link-local'], ['fe80::1', 'a link-local'], ['100.64.0.1', 'a CGNAT (Tailscale)'],
      ['100.100.100.100', 'a CGNAT (Tailscale)'], ['fd7a:115c:a1e0::1', 'a Tailscale'], ['0.0.0.0', 'an unspecified'],
      ['::', 'an unspecified'], ['::ffff:169.254.169.254', 'a link-local'], ['224.0.0.1', 'a multicast'],
    ];
    for (const [ip, kind] of never) {
      assert.equal(browserAddressRefusal(ip, false), kind, ip);
      assert.equal(browserAddressRefusal(ip, true), kind, ip);
    }
  });

  test('egressRefusal checks literals, resolves names, and passes other schemes', async () => {
    assert.equal(await egressRefusal('http://169.254.169.254/latest/api/token', false, lookup), LINK_LOCAL);
    assert.equal(await egressRefusal('http://[fe80::1]/', false, lookup), 'Refused: fe80::1 is a link-local address; the browser may not open it.');
    assert.equal(await egressRefusal('ws://100.100.100.100/', false, lookup),
      'Refused: 100.100.100.100 is a CGNAT (Tailscale) address; the browser may not open it.');
    assert.equal(await egressRefusal('https://metadata.test/', false, lookup),
      'Refused: metadata.test resolves to 169.254.169.254, a link-local address; the browser may not open it.');
    assert.equal(await egressRefusal('https://v6.test/', false, lookup),
      'Refused: v6.test resolves to fd7a:115c:a1e0::5, a Tailscale address; the browser may not open it.');
    assert.equal(await egressRefusal('https://nowhere.test/', false, lookup), 'Refused: nowhere.test did not resolve.');
    assert.equal(await egressRefusal('http://0.0.0.0:3000/', false, lookup), 'Refused: 0.0.0.0 is an unspecified address; the browser may not open it.');
    for (const url of ['http://127.0.0.1:3000/', 'http://localhost:5173/', 'http://app.localhost/', 'https://app.test/', 'http://[::1]/']) {
      assert.equal(await egressRefusal(url, true, lookup), undefined, url);
    }
    assert.equal(await egressRefusal('https://public.test/', false, lookup), undefined);
    assert.equal(await egressRefusal('https://public.test/', true, lookup), PUBLIC_REFUSED);
    assert.equal(await egressRefusal('wss://8.8.8.8/', true, lookup),
      'Refused: 8.8.8.8 is a public address; this browser opens loopback and private addresses only.');
    assert.equal(await egressRefusal('data:text/plain,hi', true, lookup), undefined);
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
    const metadata = await caller(extension)('browser_goto', { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(metadata.isError, true);
    assert.equal(textOf(metadata), LINK_LOCAL);
    assert.equal(launched, false);
  });

  test('a missing Chromium names this installation\'s fix, not Playwright\'s', async () => {
    // Playwright's own text, as playwright-core 1.62 throws it, names a package this installation does not have.
    const missing = 'browserType.launchPersistentContext: Executable doesn\'t exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell\n'
      + '╔══╗\n║ Looks like Playwright was just installed or updated. ║\n║     npx playwright install     ║\n╚══╝';
    const extension = createBrowserExtension({ profileRoot: tmpdir(), lookup, launch: () => Promise.reject(new Error(missing)) });
    await assert.rejects(caller(extension)('browser_goto', { url: 'http://127.0.0.1:9/' }), { message:
      'Chromium for the browser tools is not installed (browserType.launchPersistentContext: Executable doesn\'t exist at '
      + '/home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell). The user can run '
      + 'npx --no-install playwright-core install chromium in the installation directory, or set PI_DURABLE_CHROMIUM to a Chromium executable.' });
    const configured = createBrowserExtension({ profileRoot: tmpdir(), lookup, executablePath: '/opt/chrome',
      launch: () => Promise.reject(new Error('browserType.launchPersistentContext: Failed to launch chromium because executable doesn\'t exist at /opt/chrome')) });
    await assert.rejects(caller(configured)('browser_goto', { url: 'http://127.0.0.1:9/' }),
      /^Error: PI_DURABLE_CHROMIUM names \/opt\/chrome, which does not exist\. The user can fix the path, or unset it to use Playwright's Chromium\.$/);
    await extension.close();
    await configured.close();
  });

  test('localOnly is asked with the browser key', async () => {
    const asked: string[] = [];
    const extension = createBrowserExtension({
      profileRoot: tmpdir(), lookup, launch: () => Promise.reject(new Error('no launch')),
      keyOf: () => Promise.resolve('Reviewer'), localOnly: (key) => { asked.push(key); return key === 'Reviewer'; },
    });
    assert.equal(textOf(await caller(extension)('browser_goto', { url: 'https://public.test/' })), PUBLIC_REFUSED);
    assert.deepEqual(asked, ['Reviewer']);
  });

  test('keyOf shares one browser and profile between conversations of one key; the default keys on the conversation', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-durable-browser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const launches: string[] = [];
    let closed = 0;
    const page = { isClosed: () => false, on: () => page, goto: () => Promise.resolve(null), url: () => 'http://127.0.0.1:9/cb?code=c1#id_token=t' };
    const fake = {
      on: () => fake, pages: () => [page], close: () => { closed++; return Promise.resolve(); },
      route: () => Promise.resolve(), routeWebSocket: () => Promise.resolve(),
    };
    const launch: BrowserOptions['launch'] = (dir) => { launches.push(dir); return Promise.resolve(fake as unknown as BrowserContext); };
    const names: Record<string, string> = { 5: 'Reviewer', 7: 'Reviewer', 9: '../escape' };
    const keyed = createBrowserExtension({ profileRoot: root, launch,
      keyOf: (conversationId) => Promise.resolve(names[String(conversationId)] ?? String(conversationId)) });
    const result = await caller(keyed, 5 as ConversationId)('browser_goto', { url: 'http://127.0.0.1:9/' });
    assert.equal(textOf(result), '? http://127.0.0.1:9/cb?code=[redacted]#id_token=[redacted]');
    await caller(keyed, 7 as ConversationId)('browser_goto', { url: 'http://127.0.0.1:9/' });
    await caller(keyed, 9 as ConversationId)('browser_goto', { url: 'http://127.0.0.1:9/' });
    assert.deepEqual(launches, [join(root, 'browser', 'Reviewer'), join(root, 'browser', '9')], 'an unsafe key falls back to the ID');
    await keyed.close();
    assert.equal(closed, 2);

    launches.length = 0;
    const plain = createBrowserExtension({ profileRoot: root, launch });
    await caller(plain, 5 as ConversationId)('browser_goto', { url: 'http://127.0.0.1:9/' });
    await caller(plain, 7 as ConversationId)('browser_goto', { url: 'http://127.0.0.1:9/' });
    assert.deepEqual(launches, [join(root, 'browser', '5'), join(root, 'browser', '7')]);
    await plain.close();
  });

  test('an operation times out, and an abort cancels it', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-durable-browser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hang: BrowserOptions['launch'] = () => new Promise(() => undefined);
    const call = caller(createBrowserExtension({ profileRoot: root, launch: hang, timeoutMs: 50 }));
    // A timeout closes the browser: the agent must learn its page is gone, or it would click on nothing.
    await assert.rejects(call('browser_eval', { expression: '1' }), { message: 'Browser operation timed out after 0 s. '
      + 'The browser was closed, so its page is gone: start again with browser_goto (the profile keeps its logins).' });
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
      if (req.url?.startsWith('/oauth')) { res.writeHead(302, { location: '/?code=c0de&state=s#access_token=tok' }).end(); return; }
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
    const peek = await until(async () => textOf(await call('browser_console', { clear: false })), /pageerror: Error: boom/);
    assert.match(peek, /log: hello from page/);
    assert.match(peek, /pageerror: Error: boom/);
    assert.match(textOf(await call('browser_console', { filter: 'boom' })), /boom/);
    assert.equal(textOf(await call('browser_console')), '(empty)');
  });

  test('network lists requests with redacted authorization', async () => {
    await call('browser_network');
    await call('browser_goto', { url: `${base}/`, waitUntil: 'load' });
    const terse = await until(async () => textOf(await call('browser_network', { clear: false, urlFilter: '/api' })), /\/api/);
    assert.equal(terse, `200 GET ${base}/api`);
    const verbose = textOf(await call('browser_network', { urlFilter: '/api', verbose: true }));
    assert.match(verbose, /→ authorization: \[redacted\]/);
    assert.match(verbose, /← content-type: application\/json/);
    assert.doesNotMatch(verbose, /secret123/);
    assert.equal(textOf(await call('browser_network')), '(empty)');
  });

  test('network and goto redact OAuth codes and tokens in URLs and location', async () => {
    await call('browser_network');
    const goto = textOf(await call('browser_goto', { url: `${base}/oauth?client_secret=shh&x=1` }));
    assert.equal(goto, `200 ${base}/?code=[redacted]&state=s#access_token=[redacted]`);
    const rows = textOf(await call('browser_network', { urlFilter: '/oauth', verbose: true }));
    assert.match(rows, /^302 GET .*\/oauth\?client_secret=\[redacted\]&x=1$/m);
    assert.match(rows, /← location: \/\?\[redacted\]#\[redacted\]$/m);
    assert.doesNotMatch(rows, /c0de|shh|tok\b/);
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

describe('browser egress in Chromium', { skip }, () => {
  let server: Server;
  let port = 0;
  let root = '';
  const extensions: BrowserExtension[] = [];
  /** Upgraded sockets leave the server's books, so server.close() would wait on them forever. */
  const upgraded = new Set<Duplex>();

  const open = (localOnly: boolean): ReturnType<typeof caller> => {
    const extension = createBrowserExtension({
      profileRoot: join(root, String(extensions.length)), lookup, localOnly: () => localOnly,
      ...(executable ? { executablePath: executable } : {}),
      // The gates judge the test names by `lookup`'s answers; the proxy then dials the local server for them.
      connectAddress: (address) => address === NAMES['app.test'] || address === NAMES['public.test'] ? '127.0.0.1' : address,
      launch: (dir, options) => chromium.launchPersistentContext(dir, process.getuid?.() === 0 ? { ...options, chromiumSandbox: false } : options),
    });
    extensions.push(extension);
    return caller(extension);
  };
  const fetchFromPage = (url: string, method = 'GET') =>
    `async () => { try { const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)} }); return 'status ' + r.status; } catch { return 'blocked'; } }`;

  test.before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(); return; }
      if (req.url === '/tailnet') { res.writeHead(302, { location: 'http://100.100.100.100/' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }).end('<!doctype html><title>t</title><p>ok</p>');
    });
    // A WebSocket server that greets: just the handshake and one text frame.
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      upgraded.add(socket);
      const key = String(req.headers['sec-websocket-key']);
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 2, 0x68, 0x69]));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    root = await mkdtemp(join(tmpdir(), 'pi-durable-browser-'));
  });

  test.after(async () => {
    await Promise.all(extensions.map((extension) => extension.close()));
    for (const socket of upgraded) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  test('link-local and CGNAT are refused for navigation, redirects, fetch, workers and WebSockets', async () => {
    const call = open(false);
    const direct = await call('browser_goto', { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(direct.isError, true);
    assert.equal(textOf(direct), LINK_LOCAL);
    assert.equal(textOf(await call('browser_goto', { url: `http://127.0.0.1:${port}/meta` })), LINK_LOCAL);
    assert.equal(textOf(await call('browser_goto', { url: `http://127.0.0.1:${port}/tailnet` })),
      'Refused: 100.100.100.100 is a CGNAT (Tailscale) address; the browser may not open it.');

    await call('browser_goto', { url: `http://127.0.0.1:${port}/` });
    await call('browser_network');
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage('http://169.254.169.254/latest/api/token', 'PUT') })), 'blocked');
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage('http://100.64.0.1/') })), 'blocked');
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage('http://metadata.test/') })), 'blocked');
    const rows = await until(async () => textOf(await call('browser_network', { clear: false })), /metadata\.test/);
    assert.match(rows, /^ERR PUT http:\/\/169\.254\.169\.254\/latest\/api\/token {2}\(Refused: 169\.254\.169\.254 is a link-local address; the browser may not open it\.\)$/m);
    assert.match(rows, /^ERR GET http:\/\/100\.64\.0\.1\/ {2}\(Refused: 100\.64\.0\.1 is a CGNAT \(Tailscale\) address/m);
    assert.match(rows, /^ERR GET http:\/\/metadata\.test\/ {2}\(Refused: metadata\.test resolves to 169\.254\.169\.254/m);

    const worker = `() => new Promise((resolve) => {
      const source = "fetch('http://169.254.169.254/w').then(() => postMessage('reached'), () => postMessage('blocked'))";
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
    })`;
    assert.equal(textOf(await call('browser_eval', { expression: worker })), 'blocked');

    const socket = `() => new Promise((resolve) => {
      const ws = new WebSocket('ws://100.100.100.100/socket');
      ws.onmessage = () => resolve('message');
      ws.onclose = () => resolve('closed');
    })`;
    assert.equal(textOf(await call('browser_eval', { expression: socket })), 'closed');
    await until(async () => textOf(await call('browser_network', { clear: false, urlFilter: 'socket' })),
      /^ERR GET ws:\/\/100\.100\.100\.100\/socket {2}\(Refused: 100\.100\.100\.100 is a CGNAT/m);
  });

  test('a browser that is not local-only opens loopback, private and public addresses', async () => {
    const call = open(false);
    assert.equal(textOf(await call('browser_goto', { url: `http://127.0.0.1:${port}/` })), `200 http://127.0.0.1:${port}/`);
    assert.equal(textOf(await call('browser_goto', { url: `http://app.test:${port}/` })), `200 http://app.test:${port}/`);
    assert.equal(textOf(await call('browser_goto', { url: `http://public.test:${port}/` })), `200 http://public.test:${port}/`);
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage(`http://app.test:${port}/x`) })), 'status 200');
    const socket = `() => new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:${port}/greet');
      ws.onmessage = (e) => resolve('message ' + e.data);
      ws.onclose = () => resolve('closed');
    })`;
    assert.equal(textOf(await call('browser_eval', { expression: socket })), 'message hi');
  });

  test('a local-only browser refuses public addresses and opens loopback and private ones', async () => {
    const call = open(true);
    const refused = await call('browser_goto', { url: `http://public.test:${port}/` });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), PUBLIC_REFUSED);
    assert.equal(textOf(await call('browser_goto', { url: `http://127.0.0.1:${port}/` })), `200 http://127.0.0.1:${port}/`);
    assert.equal(textOf(await call('browser_goto', { url: `http://app.test:${port}/` })), `200 http://app.test:${port}/`);
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage(`http://public.test:${port}/x`) })), 'blocked');
    assert.equal(textOf(await call('browser_eval', { expression: fetchFromPage(`http://127.0.0.1:${port}/x`) })), 'status 200');
  });
});
