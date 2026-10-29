import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test, type TestContext } from 'node:test';
import {
  addressKind, createWebFetchExtension, extractRSCContent, isPublicAddress, MAX_OUTPUT_CHARS, webFetch, type Lookup, type WebFetchOptions,
} from '../../src/tools/web-fetch.ts';

// web_fetch offline: the address classifier, refusals before any connection, and pages served by a local server
// that only the test allowance (`allowPrivate`) lets the tool reach.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(t: TestContext, handler: Handler): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const local: WebFetchOptions = { allowPrivate: (host) => host === '127.0.0.1' };
const resolvesTo = (address: string): Lookup => () => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]);
const failingLookup: Lookup = () => Promise.reject(new Error('lookup must not run'));

const paragraph = 'Persistence keeps one never-ending chat, and this paragraph is long enough for Readability to keep it as '
  + 'the main content of the article rather than discarding it as boilerplate navigation or a footer. ';
const article = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>`
  + `<nav><a href="/">Home</a></nav><article><h1>${title}</h1>${body}</article><footer>Site footer links</footer></body></html>`;

/** A one-page PDF showing `text`, titled "Quarterly Report", with a correct xref table. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Quarterly Report) >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('isPublicAddress', () => {
  const refused: readonly [string, string][] = [
    ['127.0.0.1', 'a loopback'], ['127.255.0.9', 'a loopback'], ['::1', 'a loopback'],
    ['0.0.0.0', 'an unspecified'], ['::', 'an unspecified'],
    ['10.0.0.5', 'a private'], ['10.255.255.255', 'a private'], ['172.16.0.1', 'a private'], ['172.31.255.254', 'a private'],
    ['192.168.1.1', 'a private'],
    ['169.254.169.254', 'a link-local'], ['fe80::1', 'a link-local'], ['febf::1', 'a link-local'],
    ['100.64.0.1', 'a CGNAT (Tailscale)'], ['100.127.255.254', 'a CGNAT (Tailscale)'],
    ['fc00::1', 'a unique-local'], ['fd7a:115c:a1e0::1', 'a Tailscale'], ['fd7a:115c:a1e0:ab12::1', 'a Tailscale'], ['fd7a:115c:a1e1::1', 'a unique-local'],
    ['::ffff:127.0.0.1', 'a loopback'], ['::ffff:10.0.0.5', 'a private'], ['::ffff:a00:5', 'a private'],
    ['::ffff:169.254.1.1', 'a link-local'], ['::ffff:100.100.100.100', 'a CGNAT (Tailscale)'], ['::ffff:0.0.0.0', 'an unspecified'],
    ['::ffff:192.168.0.1', 'a private'], ['::127.0.0.1', 'a loopback'], ['64:ff9b::10.0.0.1', 'a private'],
    ['2002:c0a8:0101::1', 'a private'], ['ff02::1', 'a multicast'], ['224.0.0.1', 'a multicast'],
    ['255.255.255.255', 'a reserved'], ['not-an-ip', 'an invalid'],
  ];
  for (const [ip, kind] of refused) {
    test(`refuses ${ip}`, () => {
      assert.equal(isPublicAddress(ip), false);
      assert.equal(addressKind(ip), kind);
    });
  }
  test('accepts public addresses next to the ranges', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.1', '172.15.255.255', '172.32.0.1', '192.167.1.1',
      '100.63.255.255', '100.128.0.1', '169.253.1.1', '128.0.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888',
      '::ffff:8.8.8.8', '2002:0808:0808::1']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });
});

describe('web_fetch refusals', () => {
  test('a loopback URL is refused by default', async (t) => {
    let hits = 0;
    const base = await serve(t, (_req, res) => { hits++; res.end('secret'); });
    const result = await webFetch(`${base}/`);
    assert.deepEqual(result, { ok: false, text: 'Refused: 127.0.0.1 is a loopback address.' });
    assert.equal(hits, 0);
  });

  test('literal IPv6 and IPv4-mapped URLs are refused without a lookup', async () => {
    const options = { lookup: failingLookup };
    assert.equal((await webFetch('http://[::1]:9/', options)).text, 'Refused: ::1 is a loopback address.');
    assert.equal((await webFetch('http://[::ffff:10.0.0.5]/', options)).text, 'Refused: ::ffff:a00:5 is a private address.');
    assert.equal((await webFetch('http://169.254.169.254/latest/meta-data/', options)).text,
      'Refused: 169.254.169.254 is a link-local address.');
  });

  test('a public-looking hostname that resolves to a private address is refused', async () => {
    const result = await webFetch('https://example.local/page', { lookup: resolvesTo('10.0.0.5') });
    assert.deepEqual(result, { ok: false, text: 'Refused: example.local resolves to 10.0.0.5, a private address.' });
  });

  test('one private address among public ones is enough to refuse', async () => {
    const lookup: Lookup = () => Promise.resolve([{ address: '93.184.215.14', family: 4 }, { address: '100.101.102.103', family: 4 }]);
    const result = await webFetch('http://mixed.example/', { lookup });
    assert.equal(result.text, 'Refused: mixed.example resolves to 100.101.102.103, a CGNAT (Tailscale) address.');
  });

  test('non-http schemes and credentials are refused', async () => {
    assert.equal((await webFetch('file:///etc/passwd')).text, 'Refused: only http and https URLs, not file:');
    assert.equal((await webFetch('ftp://example.com/x')).text, 'Refused: only http and https URLs, not ftp:');
    assert.equal((await webFetch('example.com/docs')).text, 'Refused: example.com/docs is not a valid URL; include the scheme, as in https://example.com/docs.');
    assert.equal((await webFetch('http://user:pw@example.com/')).text, 'Refused: URLs with embedded credentials are not supported.');
    assert.equal((await webFetch('not a url')).ok, false);
  });

  test('a redirect from an allowed server to a private address is refused', async (t) => {
    const base = await serve(t, (_req, res) => { res.writeHead(302, { location: 'http://internal.example/admin' }).end(); });
    const lookup: Lookup = (host) => host === 'internal.example' ? resolvesTo('192.168.1.10')(host) : failingLookup(host);
    const result = await webFetch(`${base}/start`, { ...local, lookup });
    assert.deepEqual(result, { ok: false, text: 'Refused: internal.example resolves to 192.168.1.10, a private address.' });
  });

  test('a redirect to a literal loopback address on another port is refused', async (t) => {
    const base = await serve(t, (_req, res) => { res.writeHead(301, { location: 'http://[::1]:1/' }).end(); });
    assert.equal((await webFetch(base, local)).text, 'Refused: ::1 is a loopback address.');
  });

  test('more than 5 redirects fail', async (t) => {
    const base = await serve(t, (req, res) => {
      const n = Number(req.url?.slice(1)) || 0;
      res.writeHead(302, { location: `/${n + 1}` }).end();
    });
    const result = await webFetch(`${base}/0`, local);
    assert.equal(result.ok, false);
    assert.match(result.text, /Too many redirects/);
  });
});

describe('web_fetch content', () => {
  test('HTML comes back as Markdown under its title and source', async (t) => {
    const base = await serve(t, (req, res) => {
      if (req.url === '/old') { res.writeHead(308, { location: '/post' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(article('Durable Chats', `<p>${paragraph.repeat(4)}</p><h2>Details</h2><p>Some <strong>bold</strong> text.</p>`));
    });
    const result = await webFetch(`${base}/old`, local);
    assert.ok(result.ok, result.text);
    assert.equal(result.title, 'Durable Chats');
    assert.equal(result.url, `${base}/post`);
    assert.ok(result.text.startsWith(`# Durable Chats\n\nSource: ${base}/post\n\n---\n\n`), result.text.slice(0, 200));
    assert.match(result.text, /## Details/);
    assert.match(result.text, /\*\*bold\*\*/);
    assert.doesNotMatch(result.text, /<p>|Site footer|Home/);
  });

  test('a hostname resolved by the injected lookup connects to the checked address', async (t) => {
    let host: string | undefined;
    const base = await serve(t, (req, res) => { host = req.headers.host; res.end(`# Notes\n\n${paragraph}`); });
    const port = new URL(base).port;
    const options: WebFetchOptions = { lookup: resolvesTo('127.0.0.1'), allowPrivate: (name) => name === 'docs.test' };
    const result = await webFetch(`http://docs.test:${port}/notes.txt`, options);
    assert.ok(result.ok, result.text);
    assert.equal(host, `docs.test:${port}`);
    assert.equal(result.title, 'Notes');
  });

  test('output is truncated at 50,000 characters', async (t) => {
    const base = await serve(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`# Long\n\n${'x'.repeat(80_000)}`);
    });
    const result = await webFetch(`${base}/long.txt`, local);
    assert.ok(result.ok);
    assert.equal(result.text.length, MAX_OUTPUT_CHARS + '\n[Output truncated at 50,000 characters]'.length);
    assert.ok(result.text.endsWith('x\n[Output truncated at 50,000 characters]'));
  });

  test('a PDF comes back as text with its metadata title', async (t) => {
    const base = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf('Hello durable PDF')); });
    const result = await webFetch(`${base}/report_2026.pdf`, local);
    assert.ok(result.ok, result.text);
    assert.equal(result.title, 'Quarterly Report');
    assert.match(result.text, /> Pages: 1\n/);
    assert.match(result.text, /Hello durable PDF/);
  });

  test('HTTP errors and unsupported types fail', async (t) => {
    const base = await serve(t, (req, res) => {
      if (req.url === '/img') { res.writeHead(200, { 'content-type': 'image/png' }).end('png'); return; }
      res.writeHead(404, 'Not Found').end();
    });
    // An HTTP error is the server's answer, not a page that failed to render: no JavaScript hint.
    assert.equal((await webFetch(`${base}/missing`, local)).text, `${base}/missing: HTTP 404: Not Found`);
    assert.match((await webFetch(`${base}/img`, local)).text, /Unsupported content type: image\/png$/);
  });

  test('the abort signal and the timeout stop a hanging fetch', async (t) => {
    const base = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>'); });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    assert.match((await webFetch(base, local, controller.signal)).text, /Aborted$/);
    assert.match((await webFetch(base, { ...local, timeoutMs: 50 })).text, /Timed out after 0 s$/);
  });
});

describe('extractRSCContent', () => {
  const push = (lines: readonly string[]) => `<script>self.__next_f.push([1,${JSON.stringify(lines.join('\n'))}])</script>`;

  test('renders a payload of elements and references', () => {
    const html = `<html><head><title>Docs | Site</title></head><body>${push([
      `1:["$","article",null,{"children":[["$","h1",null,{"children":"Durable chats"}],"$L2"]}]`,
      `2:["$","p",null,{"children":${JSON.stringify(paragraph)}}]`,
    ])}</body></html>`;
    const result = extractRSCContent(html);
    assert.equal(result?.title, 'Docs');
    assert.match(result?.content ?? '', /^# Durable chats\n\nPersistence keeps/);
  });

  test('chunks that each cite the next one twice expand once, not 2^n times', () => {
    const n = 40;
    const lines = Array.from({ length: n }, (_, i) => {
      const id = (0x100 + i).toString(16);
      const next = (0x100 + i + 1).toString(16);
      return i === n - 1 ? `${id}:["$","p",null,{"children":"leaf text "}]` : `${id}:["$","div",null,{"children":["$L${next}","$L${next}"]}]`;
    });
    const html = `<html><body>${push(lines)}</body></html>`;
    assert.ok(html.length < 3000, String(html.length));
    const started = performance.now();
    const result = extractRSCContent(html);
    assert.ok(performance.now() - started < 2000, 'finishes fast');
    assert.ok(result);
    assert.ok(result.content.length <= 2 * MAX_OUTPUT_CHARS * 2, String(result.content.length));
    assert.match(result.content, /^leaf text/);
  });

  test('a reference cycle ends', () => {
    const html = `<html><body>${push([
      `1:["$","div",null,{"children":[${JSON.stringify(paragraph)},"$L2"]}]`, '2:["$","div",null,{"children":["$L1"]}]',
    ])}</body></html>`;
    assert.match(extractRSCContent(html)?.content ?? '', /^Persistence keeps/);
  });
});

test('the extension is web-fetch with one replay-safe tool, web_fetch', () => {
  const extension = createWebFetchExtension();
  assert.equal(extension.name, 'web-fetch');
  assert.deepEqual(extension.tools.map((tool) => [tool.name, tool.replay]), [['web_fetch', 'safe']]);
});
