import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { defineTool } from '@earendil-works/pi-durable';
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { errorMessage, isRecord } from '../protocol/util.ts';

/**
 * `web_fetch(url)`: a page as readable Markdown (Readability, Turndown), a PDF as text (unpdf), at most 50,000
 * characters. Adapted from the web-fetch extension of Pi Cloud,
 * a retired earlier project, without its TUI renderers (ADR 0027).
 *
 * It reaches public addresses only: it resolves the host, refuses when any address is loopback,
 * private, link-local, CGNAT (Tailscale), unique-local or otherwise not public, and connects to the checked address
 * itself (a pinned `lookup`, the URL's host still in SNI and Host), so a second resolution cannot rebind it. Redirects
 * are followed by hand, at most 5, each checked the same way.
 */

/** Persisted names (ADR 0027): never rename. */
export const WEB_FETCH_EXTENSION = 'web-fetch';
export const WEB_FETCH_TOOL = 'web_fetch';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;
const MAX_REDIRECTS = 5;
const MAX_PDF_PAGES = 100;
export const MAX_OUTPUT_CHARS = 50_000;

export type LookupAddress = { readonly address: string; readonly family: number };
/** Every address of `hostname`, as `dns.lookup(hostname, { all: true })` returns them. */
export type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>;

export type WebFetchOptions = {
  /** Default: `node:dns` lookup of all addresses. */
  readonly lookup?: Lookup;
  /** Tests only: hosts (URL hostnames) allowed to resolve to non-public addresses. Default: none. */
  readonly allowPrivate?: (host: string) => boolean;
  /** Default 30 s, for the whole fetch including redirects and the body. */
  readonly timeoutMs?: number;
};

export type WebFetchResult =
  | { readonly ok: true; readonly text: string; readonly url: string; readonly title: string; readonly chars: number }
  | { readonly ok: false; readonly text: string };

// ── Address checks ───────────────────────────────────────────────────

const v4Octets = (ip: string): number[] | undefined => {
  if (isIP(ip) !== 4) return undefined;
  return ip.split('.').map(Number);
};

/** The eight 16-bit words of an IPv6 address, with a dotted IPv4 tail expanded; undefined when not IPv6. */
const v6Words = (ip: string): number[] | undefined => {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.split('%')[0] ?? '';
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) => (part ? part.split(':').map((word) => parseInt(word, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
};

const v4Kind = ([a = 0, b = 0, c = 0]: readonly number[]): string | undefined => {
  if (a === 0) return b === 0 && c === 0 ? 'an unspecified' : 'a reserved';
  if (a === 127) return 'a loopback';
  if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) return 'a private';
  if (a === 169 && b === 254) return 'a link-local';
  if (a === 100 && b >= 64 && b < 128) return 'a CGNAT (Tailscale)';
  if (a === 192 && b === 0 && c === 0) return 'a reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'a reserved';
  if (a >= 224) return a < 240 ? 'a multicast' : 'a reserved';
  return undefined;
};

const embeddedV4 = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];

/**
 * Why `ip` is not a public address, as an article and adjective ("a private"), or undefined when it is public.
 * IPv4-mapped, IPv4-compatible, NAT64 and 6to4 IPv6 forms are judged by the IPv4 address they carry.
 */
export function addressKind(ip: string): string | undefined {
  const octets = v4Octets(ip);
  if (octets) return v4Kind(octets);
  const words = v6Words(ip);
  if (!words) return 'an invalid';
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const upperZero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  if (upperZero && w5 === 0 && w6 === 0) return w7 === 0 ? 'an unspecified' : w7 === 1 ? 'a loopback' : 'a reserved';
  if (upperZero && (w5 === 0xffff || w5 === 0)) return v4Kind(embeddedV4(w6, w7));
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return v4Kind(embeddedV4(w6, w7));
  if (w0 === 0x2002) return v4Kind(embeddedV4(w1, w2));
  if ((w0 & 0xffc0) === 0xfe80) return 'a link-local';
  if (w0 === 0xfd7a && w1 === 0x115c && w2 === 0xa1e0) return 'a Tailscale';
  if ((w0 & 0xfe00) === 0xfc00) return 'a unique-local';
  if ((w0 & 0xff00) === 0xff00) return 'a multicast';
  // Global unicast is 2000::/3; everything else is unassigned or special.
  return (w0 & 0xe000) === 0x2000 ? undefined : 'a reserved';
}

/** Whether `ip` (IPv4 or IPv6, textual) is a public unicast address that web_fetch may connect to. */
export const isPublicAddress = (ip: string): boolean => addressKind(ip) === undefined;

/** The default `Lookup`: every address `node:dns` finds for `hostname`. The browser tools check hosts with it too. */
export const lookupAll: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

class Refusal extends Error {}

/** Resolve `url`'s host and return the one address to connect to, or throw a `Refusal`. */
async function checkedAddress(url: URL, options: WebFetchOptions): Promise<LookupAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await (options.lookup ?? lookupAll)(host);
  if (!addresses.length) throw new Error(`${host} did not resolve`);
  if (!options.allowPrivate?.(host)) {
    for (const { address } of addresses) {
      const kind = addressKind(address);
      if (kind === undefined) continue;
      throw new Refusal(literal
        ? `Refused: ${host} is ${kind} address.`
        : `Refused: ${host} resolves to ${address}, ${kind} address.`);
    }
  }
  const [first] = addresses;
  if (!first) throw new Error(`${host} did not resolve`);
  return first;
}

function checkUrl(raw: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(raw, base); } catch {
    // Models often leave out the scheme ("example.com/docs"); say how to fix it rather than only refusing.
    const hint = !base && !raw.includes('://') && URL.canParse(`https://${raw}`) ? `; include the scheme, as in https://${raw}` : '';
    throw new Refusal(`Refused: ${raw} is not a valid URL${hint}.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refusal(`Refused: only http and https URLs, not ${url.protocol}`);
  if (url.username || url.password) throw new Refusal('Refused: URLs with embedded credentials are not supported.');
  return url;
}

// ── HTTP ─────────────────────────────────────────────────────────────

/** A `lookup` that answers every query with `address`, so the socket connects to the checked address only. */
const pinned = (address: LookupAddress): LookupFunction => (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address: address.address, family: address.family }]);
  else callback(null, address.address, address.family);
};

/**
 * Agents of web_fetch's own, never the global ones: Node may give its global agents a proxy from the environment
 * (`NODE_USE_ENV_PROXY`), which would resolve and connect itself, past the pinned lookup. No keep-alive, so a socket
 * pinned to one address is never reused for another request.
 */
const httpAgent = new HttpAgent({ keepAlive: false });
const httpsAgent = new HttpsAgent({ keepAlive: false });

function get(url: URL, address: LookupAddress, signal: AbortSignal): Promise<IncomingMessage> {
  const https = url.protocol === 'https:';
  const options: RequestOptions = {
    method: 'GET',
    signal,
    agent: https ? httpsAgent : httpAgent,
    lookup: pinned(address),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    },
  };
  const send = https ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, options, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** GET `url`, following at most 5 redirects; every hop's host is checked and pinned. */
async function fetchChecked(start: URL, options: WebFetchOptions, signal: AbortSignal): Promise<{ url: URL; response: IncomingMessage }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const response = await get(url, await checkedAddress(url, options), signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status < 300 || status >= 400 || status === 304 || !location) return { url, response };
    response.destroy();
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    url = checkUrl(location, url);
  }
}

/** The decoded body, at most `max` bytes after decompression. */
async function boundedBody(response: IncomingMessage, max: number): Promise<Buffer> {
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress() : undefined;
  const stream: Readable = decoder ? response.pipe(decoder) : response;
  if (decoder) response.on('error', (error) => decoder.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) continue;
      size += chunk.byteLength;
      if (size > max) throw new Error(`Response too large (over ${Math.round(max / 1024 / 1024)}MB)`);
      chunks.push(chunk);
    }
  } finally {
    response.destroy();
    decoder?.destroy();
  }
  return Buffer.concat(chunks, size);
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

// ── Extraction ───────────────────────────────────────────────────────

/**
 * Why a fetched page gave no usable content: the server's own answer (`http`, `too_large`, `unsupported`), or a page
 * that loaded but would not extract (`unreadable`, maybe JavaScript-rendered).
 */
type Failure = { readonly kind: 'http' | 'too_large' | 'unsupported' | 'unreadable'; readonly message: string };
type Extracted = { title: string; content: string; failure?: Failure };

const isPDF = (url: URL, contentType: string) =>
  contentType.includes('application/pdf') || url.pathname.toLowerCase().endsWith('.pdf');

/** `value` when it is a plain object, else undefined. */
const asRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;

/** Call `target[method](...args)` on a pdf.js object this project has no types for, or throw. */
async function callMethod(target: unknown, method: string, ...args: unknown[]): Promise<unknown> {
  const fn = asRecord(target)?.[method];
  if (typeof fn !== 'function') throw new Error(`PDF: no ${method}()`);
  const value: unknown = await Reflect.apply(fn, target, args);
  return value;
}

/** One page's text, as unpdf's `extractText` joins it. */
async function pageText(pdf: unknown, pageNumber: number): Promise<string> {
  const page = await callMethod(pdf, 'getPage', pageNumber);
  const items = asRecord(await callMethod(page, 'getTextContent'))?.items;
  if (!Array.isArray(items)) return '';
  const list: readonly unknown[] = items;
  return list.map((item) => {
    const fields = asRecord(item);
    return typeof fields?.str === 'string' ? fields.str + (fields.hasEOL === true ? '\n' : '') : '';
  }).join('');
}

async function extractPDF(bytes: Buffer, url: URL, signal: AbortSignal): Promise<Extracted> {
  // unpdf's typed helpers: its getDocumentProxy types point at pdf.js declarations the package does not ship.
  const { getDocumentProxy, getMeta } = await import('unpdf');
  const pdf: unknown = await getDocumentProxy(new Uint8Array(bytes));
  try {
    return await pdfContent(pdf, url, signal, await getMeta(pdf));
  } finally {
    await callMethod(pdf, 'destroy').catch(() => undefined);
  }
}

async function pdfContent(pdf: unknown, url: URL, signal: AbortSignal, meta: { readonly info: Readonly<Record<string, unknown>> }): Promise<Extracted> {
  const info = meta.info;
  const metaTitle = typeof info.Title === 'string' ? info.Title.trim() : '';
  const metaAuthor = typeof info.Author === 'string' ? info.Author.trim() : '';
  const urlTitle = basename(url.pathname, '.pdf').replace(/[_-]+/g, ' ').trim() || 'document';
  const title = metaTitle || urlTitle;

  const numPages = asRecord(pdf)?.numPages;
  const totalPages = typeof numPages === 'number' ? numPages : 0;
  const maxPages = Math.min(totalPages, MAX_PDF_PAGES);
  // Page by page, the first 100 only, and stoppable: a long PDF must not hold the host past an abort or the timeout.
  const pages: string[] = [];
  for (let n = 1; n <= maxPages; n++) {
    signal.throwIfAborted();
    const text = (await pageText(pdf, n)).replace(/\s+/g, ' ').trim();
    if (text) pages.push(text);
  }
  const truncated = totalPages > maxPages;
  const lines = [
    `# ${title}`, '', `> Source: ${url.href}`,
    `> Pages: ${totalPages}${truncated ? ` (extracted first ${maxPages})` : ''}`,
  ];
  if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
  lines.push('', '---', '', pages.join('\n\n'));
  if (truncated) lines.push('', '---', '', `*[Truncated: Only first ${maxPages} of ${totalPages} pages extracted]*`);
  return { title, content: lines.join('\n') };
}

/** Bounds on the RSC walk: nodes visited, and characters any one piece of text may grow to. */
const MAX_RSC_NODES = 200_000;
const MAX_RSC_CHARS = 2 * MAX_OUTPUT_CHARS;

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'path', 'circle', 'link', 'meta', 'template', 'button', 'input', 'nav', 'footer', 'aside']);

/** Readable text from a Next.js React Server Components payload (`self.__next_f.push`), for pages Readability misses. */
export function extractRSCContent(html: string): { title: string; content: string } | undefined {
  if (!html.includes('self.__next_f.push')) return undefined;
  const chunks = new Map<string, string>();
  for (const match of html.matchAll(/<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g)) {
    let decoded: unknown;
    try { decoded = JSON.parse(`"${match[1] ?? ''}"`); } catch { continue; }
    if (typeof decoded !== 'string') continue;
    for (const line of decoded.split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0 || colon > 4) continue;
      const id = line.slice(0, colon);
      const payload = line.slice(colon + 1);
      if (!/^[0-9a-f]+$/i.test(id) || !payload) continue;
      if (payload.length > (chunks.get(id)?.length ?? 0)) chunks.set(id, payload);
    }
  }
  if (!chunks.size) return undefined;
  const title = /<title[^>]*>([^<]+)<\/title>/.exec(html)?.[1]?.split('|')[0]?.trim() ?? '';

  const parsed = new Map<string, unknown>();
  const chunk = (id: string): unknown => {
    if (parsed.has(id)) return parsed.get(id);
    const text = chunks.get(id);
    let value: unknown;
    try { value = text?.startsWith('[') ? JSON.parse(text) : undefined; } catch { value = undefined; }
    parsed.set(id, value);
    return value;
  };

  // `visited` holds the chunks being expanded (a reference back to one is a cycle); `expanded` memoizes each chunk's
  // text, so a chunk referenced many times (chunk n citing chunk n+1 twice, n deep) is walked once, not 2^n times.
  // Each text is capped and the walk has a node budget, so no payload can hold the host.
  const visited = new Set<string>();
  const expanded = new Map<string, string>();
  let nodes = 0;
  const cap = (text: string) => text.length > MAX_RSC_CHARS ? text.slice(0, MAX_RSC_CHARS) : text;
  const follow = (id: string, inCode: boolean): string => {
    if (visited.has(id)) return '';
    const key = `${inCode ? 'c' : 't'}${id}`;
    const known = expanded.get(key);
    if (known !== undefined) return known;
    visited.add(id);
    const node = chunk(id);
    const text = node ? walk(node, inCode) : '';
    visited.delete(id);
    expanded.set(key, text);
    return text;
  };
  const walkAll = (items: readonly unknown[], inCode: boolean): string => {
    let text = '';
    for (const item of items) {
      text += walk(item, inCode);
      if (text.length >= MAX_RSC_CHARS) break;
    }
    return cap(text);
  };
  const walk = (node: unknown, inCode = false): string => cap(walkNode(node, inCode));
  const walkNode = (node: unknown, inCode: boolean): string => {
    if (++nodes > MAX_RSC_NODES) return '';
    if (typeof node === 'string') {
      const ref = /^\$L([0-9a-f]+)$/i.exec(node)?.[1];
      if (ref) return follow(ref, inCode);
      if (!inCode && (node === '$undefined' || node === '$' || /^\$[A-Z]/.test(node))) return '';
      return node.trim() ? node : '';
    }
    if (typeof node === 'number') return String(node);
    if (!Array.isArray(node)) return '';
    const items: readonly unknown[] = node;
    const [marker, tag] = items;
    if (marker !== '$' || typeof tag !== 'string') return walkAll(items, inCode);
    if (SKIP_TAGS.has(tag)) return '';
    const props = asRecord(items[3]) ?? {};
    const children: unknown = props.children;
    if (tag.startsWith('$L')) {
      const id = tag.slice(2);
      if (visited.has(id)) return '';
      if (props.baseId && children) return `## ${typeof children === 'string' ? children : walk(children)}\n\n`;
      const node = chunk(id);
      if (node) return follow(id, inCode);
      return children ? walk(children, inCode) : '';
    }
    const content = children ? walk(children, inCode) : '';
    const heading = /^h([1-6])$/.exec(tag)?.[1];
    if (heading) return `${'#'.repeat(Number(heading))} ${content.trim()}\n\n`;
    switch (tag) {
      case 'p': return `${content.trim()}\n\n`;
      case 'code': { const code = children ? walk(children, true) : ''; return inCode ? code : `\`${code}\``; }
      case 'pre': return `\`\`\`\n${children ? walk(children, true) : ''}\n\`\`\`\n\n`;
      case 'strong': case 'b': return `**${content}**`;
      case 'em': case 'i': return `*${content}*`;
      case 'li': return `- ${content.trim()}\n`;
      case 'ul': case 'ol': return `${content}\n`;
      case 'blockquote': return `> ${content.trim()}\n\n`;
      case 'a': return typeof props.href === 'string' && !props.href.startsWith('#') ? `[${content}](${props.href})` : content;
      default: return content;
    }
  };

  const main = chunk('23');
  if (main) {
    const content = walk(main);
    if (content.trim().length > 100) return { title, content: content.replace(/\n{3,}/g, '\n\n').trim() };
  }
  const parts: { order: number; text: string }[] = [];
  for (const id of chunks.keys()) {
    if (id === '23') continue;
    const node = chunk(id);
    if (!node) continue;
    visited.clear();
    const text = walk(node).trim();
    if (text.length > 50 && !text.includes('page was not found') && !text.includes('404')) parts.push({ order: parseInt(id, 16), text });
  }
  parts.sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const unique = parts.filter(({ text }) => !seen.has(text.slice(0, 150)) && seen.add(text.slice(0, 150)));
  const content = unique.map(({ text }) => text).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return content.length > 100 ? { title, content } : undefined;
}

function isLikelyJSRendered(html: string): boolean {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  if (body === undefined) return false;
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return text.length < 500 && (html.match(/<script/gi) ?? []).length > 3;
}

const headingTitle = (text: string): string | undefined =>
  /^#{1,2}\s+(.+)/m.exec(text)?.[1]?.replace(/\*+/g, '').trim() || undefined;

const JS_RENDERED = 'Page appears to be JavaScript-rendered (content loads dynamically)';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/**
 * Readability's article HTML as a linkedom node: Turndown converts a DOM node as well as a string, and a node spares it
 * a second parse with its own bundled DOM. Undefined if linkedom gave no body.
 */
function articleRoot(content: string): unknown {
  const parsed: unknown = parseHTML(`<!doctype html><html><body>${content}</body></html>`);
  return asRecord(asRecord(parsed)?.document)?.body;
}

const unreadable = (html: string, message: string): Failure => ({ kind: 'unreadable', message: isLikelyJSRendered(html) ? JS_RENDERED : message });

function extractHTML(html: string): Extracted {
  // linkedom's types name DOM globals this project's lib leaves out; Readability only needs its document.
  const window: unknown = parseHTML(html);
  const document: unknown = asRecord(window)?.document;
  const article = new Readability(document).parse();
  if (!article?.content) {
    const rsc = extractRSCContent(html);
    if (rsc) return rsc;
    return { title: '', content: '', failure: unreadable(html, 'Could not extract readable content from HTML structure') };
  }
  const title = article.title ?? '';
  const markdown = turndown.turndown(articleRoot(article.content) ?? article.content);
  if (markdown.length < MIN_USEFUL_CONTENT) {
    return { title, content: markdown, failure: unreadable(html, 'Extracted content appears incomplete') };
  }
  return { title, content: markdown };
}

const UNSUPPORTED = ['application/octet-stream', 'image/', 'audio/', 'video/', 'application/zip'];

async function extract(start: URL, options: WebFetchOptions, signal: AbortSignal): Promise<Extracted & { url: URL }> {
  const { url, response } = await fetchChecked(start, options, signal);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.destroy();
    return { url, title: '', content: '', failure: { kind: 'http', message: `HTTP ${status}: ${response.statusMessage ?? ''}`.trim() } };
  }
  const contentType = response.headers['content-type'] ?? '';
  const pdf = isPDF(url, contentType);
  const max = pdf ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;
  const length = parseInt(response.headers['content-length'] ?? '', 10);
  if (length > max) {
    response.destroy();
    return { url, title: '', content: '', failure: { kind: 'too_large', message: `Response too large (${Math.round(length / 1024 / 1024)}MB)` } };
  }
  if (pdf) return { url, ...await extractPDF(await boundedBody(response, max), url, signal) };
  if (UNSUPPORTED.some((type) => contentType.includes(type))) {
    response.destroy();
    return { url, title: '', content: '', failure: { kind: 'unsupported', message: `Unsupported content type: ${contentType.split(';')[0] ?? ''}` } };
  }
  const text = decodeText(await boundedBody(response, max), contentType);
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    return { url, title: headingTitle(text) ?? (url.pathname.split('/').pop() || url.href), content: text };
  }
  return { url, ...extractHTML(text) };
}

/**
 * Fetch `raw` and return it as readable Markdown under a title and source header, truncated at 50,000 characters, or
 * an error text (`ok: false`): a refusal, an HTTP or size error, a timeout, or content that would not extract.
 */
export async function webFetch(raw: string, options: WebFetchOptions = {}, signal?: AbortSignal): Promise<WebFetchResult> {
  const fail = (message: string): WebFetchResult => ({ ok: false, text: `${raw}: ${message}` });
  if (signal?.aborted) return fail('Aborted');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const limit = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let result: Extracted & { url: URL };
  try {
    result = await extract(checkUrl(raw), options, limit);
  } catch (error) {
    if (signal?.aborted) return fail('Aborted');
    if (timeout.aborted) return fail(`Timed out after ${Math.round(timeoutMs / 1000)} s`);
    // A refusal stands alone: it names the URL or address it refused.
    if (error instanceof Refusal) return { ok: false, text: error.message };
    return fail(errorMessage(error));
  }
  if (result.failure) {
    // The JavaScript hint is for pages that loaded but would not extract, not for the server's own answers.
    const { kind, message } = result.failure;
    return fail(kind !== 'unreadable' ? message : `${message}\n\nThe page may be JavaScript-rendered. Try a different URL for the same content, or the browser tools.`);
  }
  const header = result.title ? `# ${result.title}\n\nSource: ${result.url.href}\n\n---\n\n` : '';
  const full = header + result.content;
  const text = full.length > MAX_OUTPUT_CHARS
    ? `${full.slice(0, MAX_OUTPUT_CHARS)}\n[Output truncated at 50,000 characters]` : full;
  return { ok: true, text, url: result.url.href, title: result.title, chars: result.content.length };
}

export type WebFetchExtension = Extension & { readonly name: typeof WEB_FETCH_EXTENSION; readonly tools: readonly ToolRegistration[] };

/** The `web-fetch` extension with its one tool, `web_fetch`. `options` are for tests; production passes none. */
export function createWebFetchExtension(options: WebFetchOptions = {}): WebFetchExtension {
  const webFetchTool = defineTool({
    name: WEB_FETCH_TOOL,
    description: 'Fetch a public web page and return its readable content as Markdown (HTML via Readability and Turndown, '
      + 'PDFs as text, plain text as is), at most 50,000 characters. Refuses private, loopback and Tailscale addresses. '
      + 'Sends URLs to no third-party reader service; use the browser tools for JavaScript-rendered pages.',
    parameters: obj({ url: str({ description: 'http or https URL to fetch' }) }, { open: true }),
    // Read-only: rerunning an interrupted fetch on recovery repeats a GET and changes nothing.
    replay: 'safe',
    execute: async ({ url }, _api, context) => {
      const result = await webFetch(url, options, context.abortSignal);
      if (!result.ok) return { output: [{ type: 'text', text: result.text }], isError: true };
      return {
        output: [{ type: 'text', text: result.text }],
        details: { url: result.url, title: result.title, chars: result.chars },
      };
    },
  });
  return { name: WEB_FETCH_EXTENSION, tools: [webFetchTool] };
}
