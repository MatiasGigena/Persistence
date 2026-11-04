import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Agent as HttpAgent, createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http';
import { connect, isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Context, JsonValue } from '@earendil-works/chord';
import { defineTool } from '@earendil-works/pi-durable';
import type { ConversationId, Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { arr, bool, num, obj, opt, type Schema, str, union } from '@earendil-works/pi-schema';
import {
  type BrowserContext, chromium, type ConsoleMessage, type Page, type Request, type Route, type WebSocketRoute,
} from 'playwright-core';
import { addressKind, type Lookup, type LookupAddress, lookupAll } from './web-fetch.ts';
import { errorMessage } from '../protocol/util.ts';

/**
 * Browser tools: a headless Chromium per agent, adapted from the browser extension of Pi Cloud,
 * a retired earlier project (ADR 0027).
 *
 * Each browser is keyed by `keyOf(conversationId)`: the host maps every session of an agent (a standing agent gets a new
 * conversation per task) to the agent's name, so the agent keeps one Chromium and one persistent profile,
 * `<profileRoot>/browser/<key>`, whose cookies and localStorage survive between calls, tasks and restarts. Each browser
 * has one queue: Playwright's Page is not safe for concurrent use, so a `goto` and an `eval` fired in one round must not
 * interleave, and two sessions of one agent running at once (rare) take turns on the same page. Each operation, queue wait included,
 * has 60 s; a timeout or an abort closes that browser, and the next call relaunches it. Navigation is HTTP(S) only.
 * There is no `/browser on` gate and no manual control from the web UI.
 *
 * Egress: every request the page makes (navigations, subresources, fetch and XHR, each redirect hop, WebSockets) is
 * checked in Node before Chromium may send it (`egressCheck`, enforced by the routes and a per-browser egress proxy). Loopback and private addresses are allowed, since the
 * browser is for debugging the user's apps; link-local (cloud metadata), CGNAT and Tailscale addresses and the
 * unspecified and reserved ones are always refused; a `localOnly` browser refuses public addresses too. Service workers
 * are blocked, since their requests would pass the routes unchecked.
 *
 * pi-durable extensions have no shutdown hook, so the host calls `close()` when it closes the Harness.
 */

export const BROWSER_EXTENSION = 'browser';
/** Entries kept per buffer (console, network); older ones are dropped. */
export const MAX_BUFFER = 1000;
export const OPERATION_TIMEOUT_MS = 60_000;
const EVAL_LIMIT = 50_000;
/** A string literal as TypeBox wrote it (`type` and `const`), so the tool's JSON Schema stays as it was. */
const literal = <const V extends string>(value: V): Schema<V> => ({ type: 'string', const: value });
const MAX_FULL_PAGE_PIXELS = 8_000_000;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

/** Headers `browser_network` shows with `verbose`; `includeHeaders` adds more for one call. */
export const KEEP_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'apikey', 'content-type', 'x-client-info', 'accept-profile', 'content-profile', 'prefer', 'location',
  'www-authenticate', 'retry-after',
]);
const SENSITIVE = /authorization|cookie|api[-_]?key|token|secret|session|csrf|xsrf|(?:^|[^a-z])sid(?:$|[^a-z])/i;
/** Query and fragment parameters whose values `redactUrl` hides. */
const SENSITIVE_PARAM = /token|code|secret|key|auth|session|password|sig|csrf|xsrf|(?:^|[^a-z])sid(?:$|[^a-z])/i;
const REDACTED = '[redacted]';
/** A JWT: three base64url parts, the first a JSON object (`{"` is `eyJ`). */
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

function redactParams(params: string): string {
  return params.split('&').map((pair) => {
    const at = pair.indexOf('=');
    if (at < 0) return pair;
    let name = pair.slice(0, at);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep it raw */ }
    return SENSITIVE_PARAM.test(name) ? `${pair.slice(0, at)}=${REDACTED}` : pair;
  }).join('&');
}

/**
 * `url` (absolute or not) without its `user:pass@` and with the values of sensitive query and fragment parameters
 * (`code=`, `#access_token=`) hidden.
 */
const stripUserinfo = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');

export function redactUrl(raw: string): string {
  const url = stripUserinfo(raw);
  const hash = url.indexOf('#');
  const before = hash < 0 ? url : url.slice(0, hash);
  const question = before.indexOf('?');
  const path = question < 0 ? before : `${before.slice(0, question)}?${redactParams(before.slice(question + 1))}`;
  return hash < 0 ? path : `${path}#${redactParams(url.slice(hash + 1))}`;
}

/** Console text with JWTs hidden, and URLs in it redacted as `redactUrl` does. */
export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => redactUrl(url)).replace(JWT, REDACTED);
}

/** A `location` header with its whole query and fragment hidden: redirects carry OAuth codes and tokens there. */
export function redactLocation(raw: string): string {
  const url = stripUserinfo(raw);
  const hash = url.indexOf('#');
  const before = hash < 0 ? url : url.slice(0, hash);
  const question = before.indexOf('?');
  return (question < 0 ? before : `${before.slice(0, question)}?${REDACTED}`) + (hash < 0 ? '' : `#${REDACTED}`);
}

/**
 * The headers in `allow` (lower-case names), with sensitive values replaced by `[redacted]`, a `location`'s query and
 * fragment hidden, and a `referer`'s sensitive parameters.
 */
export function filterHeaders(headers: Readonly<Record<string, string>>, allow: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!allow.has(lower)) continue;
    out[name] = SENSITIVE.test(name) ? REDACTED : lower === 'location' ? redactLocation(value)
      : lower === 'referer' ? redactUrl(value) : value;
  }
  return out;
}

/** Parse `url`, refusing anything but http: and https:. */
export function httpUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP(S) navigation is allowed');
  return parsed;
}

// ── Egress ───────────────────────────────────────────────────────────

/** Address kinds (`addressKind`) every browser may open besides public ones: the user's machine and LAN. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(['a loopback', 'a private', 'a unique-local']);

/**
 * Why a browser may not open `address`, as an article and adjective (`a link-local`), or undefined when it may.
 * Loopback, private (RFC 1918) and unique-local addresses are allowed; public ones unless `localOnly`; every other kind
 * (link-local, CGNAT and Tailscale, unspecified, multicast, reserved) never.
 */
export function browserAddressRefusal(address: string, localOnly: boolean): string | undefined {
  const kind = addressKind(address);
  if (kind === undefined) return localOnly ? 'a public' : undefined;
  return LOCAL_KINDS.has(kind) ? undefined : kind;
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** An egress verdict: the reason a request is refused, or the checked addresses to connect to (none for `data:` and such). */
export type EgressCheck =
  | { readonly refusal: string; readonly addresses?: undefined }
  | { readonly refusal?: undefined; readonly addresses: readonly LookupAddress[] };

const LOOPBACK: readonly LookupAddress[] = [{ address: '127.0.0.1', family: 4 }];

/**
 * Whether a browser may send a request to `raw`. The host of an http(s) or ws(s) URL is checked as an IP literal, or
 * resolved with `lookup` and refused when any of its addresses is; a host that does not resolve is refused too, except
 * `localhost` and `*.localhost`, which are loopback. Other schemes (`data:`, `blob:`, `about:`) open no connection.
 *
 * Two layers apply it. The context's routes refuse a request before Chromium sends it, with the reason in the request's
 * failure; they cannot see redirect hops or a worker's WebSocket. The egress proxy (`startEgressProxy`) sees every
 * connection and dials only the addresses this check returned, which also closes DNS rebinding: Chromium resolving the
 * name again would need `--host-resolver-rules`, fixed at launch and not per request, so the proxy resolves instead.
 * Accepted residue: the lookup itself sends the name to the resolver, so a `localOnly` browser can still leak a
 * hostname's labels through DNS, though no connection to a public address is ever made.
 */
export async function egressCheck(raw: string, localOnly: boolean, lookup: Lookup = lookupAll): Promise<EgressCheck> {
  let url: URL;
  try { url = new URL(raw); } catch { return { refusal: `Refused: ${raw} is not a valid URL.` }; }
  if (!WEB_SCHEMES.has(url.protocol)) return { addresses: [] };
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const why = (kind: string) => kind === 'a public'
    ? 'this browser opens loopback and private addresses only.' : 'the browser may not open it.';
  const family = isIP(host);
  if (family) {
    const kind = browserAddressRefusal(host, localOnly);
    return kind ? { refusal: `Refused: ${host} is ${kind} address; ${why(kind)}` } : { addresses: [{ address: host, family }] };
  }
  let addresses: readonly LookupAddress[];
  try { addresses = await lookup(host); } catch { addresses = []; }
  if (!addresses.length && (host === 'localhost' || host.endsWith('.localhost'))) addresses = LOOPBACK;
  if (!addresses.length) return { refusal: `Refused: ${host} did not resolve.` };
  for (const { address } of addresses) {
    const kind = browserAddressRefusal(address, localOnly);
    if (kind) return { refusal: `Refused: ${host} resolves to ${address}, ${kind} address; ${why(kind)}` };
  }
  return { addresses };
}

/** `egressCheck`'s refusal for `raw`, or undefined when a browser may open it. */
export const egressRefusal = async (raw: string, localOnly: boolean, lookup: Lookup = lookupAll): Promise<string | undefined> =>
  (await egressCheck(raw, localOnly, lookup)).refusal;

/** How long a host's verdict is reused: a page loads many resources from one host. */
const VERDICT_TTL_MS = 5_000;

/** The header the egress proxy sets on the 403 it answers a refused plain-HTTP request with. */
const REFUSED_HEADER = 'x-pi-durable-refused';

/** A `lookup` that answers with the checked addresses only, so a socket connects where the check looked. */
const pinnedAll = (addresses: readonly LookupAddress[]): LookupFunction => (_hostname, options, callback) => {
  const [first] = addresses;
  if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
  else if (first) callback(null, first.address, first.family);
  else callback(new Error('no address'), '', 4);
};

type EgressProxy = { readonly server: string; readonly username: string; readonly password: string; close(): void };

type ProxyHooks = {
  readonly check: (url: string) => Promise<EgressCheck>;
  readonly refused: (url: string, refusal: string) => void;
  /** Tests only: the address to connect to for a checked one. */
  readonly connectAddress?: (address: string) => string;
};

/**
 * One browser's egress proxy, on loopback behind a random Basic credential that only its Chromium is given. Chromium
 * sends every connection through it (Playwright proxies loopback too), so it sees what the context's routes cannot:
 * each redirect hop, WebSockets from workers, WebRTC over TCP (UDP is off). It checks each host as the routes do, then
 * connects to the addresses it checked, so a DNS answer that changes between the check and the connection (rebinding)
 * reaches nothing new. Plain HTTP is forwarded; HTTPS and WebSockets are CONNECT tunnels, checked by host and port.
 */
async function startEgressProxy(hooks: ProxyHooks): Promise<EgressProxy> {
  const username = 'pi-durable';
  const password = randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers['proxy-authorization'] ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const challenge = 'Proxy-Authenticate: Basic realm="pi-durable browser"';
  const agent = new HttpAgent({ keepAlive: false });
  const tunnels = new Set<Duplex>();
  const target = (addresses: readonly LookupAddress[]): readonly LookupAddress[] => {
    const map = hooks.connectAddress;
    return map ? addresses.map(({ address }) => { const mapped = map(address); return { address: mapped, family: isIP(mapped) || 4 }; }) : addresses;
  };

  const forward = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req)) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pi-durable browser"' }).end(); return; }
    const url = req.url ?? '';
    if (!url.startsWith('http://')) { res.writeHead(400).end(); return; }
    const verdict = await hooks.check(url);
    if (verdict.refusal !== undefined) {
      hooks.refused(url, verdict.refusal);
      res.writeHead(403, { 'content-type': 'text/plain', [REFUSED_HEADER]: verdict.refusal }).end(verdict.refusal);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest(url, {
      method: req.method ?? 'GET', headers, agent, lookup: pinnedAll(target(verdict.addresses)),
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, response.rawHeaders);
      response.pipe(res);
    });
    upstream.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };

  const tunnel = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    socket.on('error', () => socket.destroy());
    if (!authorized(req)) { socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\n${challenge}\r\nContent-Length: 0\r\n\r\n`); return; }
    const authority = req.url ?? '';
    const url = `https://${authority}/`;
    let parsed: URL;
    try { parsed = new URL(url); } catch { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
    const verdict = await hooks.check(url);
    if (verdict.refusal !== undefined) {
      hooks.refused(url, verdict.refusal);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({
      host: parsed.hostname.replace(/^\[|\]$/g, ''), port: Number(parsed.port || 443),
      lookup: pinnedAll(target(verdict.addresses)), autoSelectFamily: true,
    });
    let connected = false;
    tunnels.add(upstream);
    upstream.on('close', () => { tunnels.delete(upstream); if (connected) socket.destroy(); });
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (!connected) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      upstream.destroy();
    });
    upstream.on('connect', () => {
      connected = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  };

  const server = createServer();
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    forward(req, res).catch(() => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
  });
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    tunnel(req, socket, head).catch(() => socket.destroy());
  });
  // Chromium tunnels WebSockets with CONNECT; an upgrade sent as a plain request is not forwarded.
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  // A browser that never closed (its launch failed or hung) must not keep the process alive.
  server.unref();
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  return {
    server: `http://127.0.0.1:${port}`, username, password,
    close: () => {
      server.close();
      server.closeAllConnections();
      for (const socket of tunnels) socket.destroy();
      agent.destroy();
    },
  };
}

/**
 * Page source that evaluates `source` once and calls the value if it is a function, so an expression, a function
 * (`() => x`, `async () => {...}`) and an already-called IIFE all work. Wrapping by regex instead double-calls IIFEs.
 */
export const evalSource = (source: string): string =>
  `(() => { const __v = (${source}); return typeof __v === 'function' ? __v() : __v; })()`;

export type BrowserLaunchOptions = {
  readonly headless: true;
  readonly chromiumSandbox: true;
  /** Service workers would fetch past the context's routes, unchecked. */
  readonly serviceWorkers: 'block';
  /** The browser's egress proxy (`startEgressProxy`): every connection goes through it. */
  readonly proxy: { readonly server: string; readonly username: string; readonly password: string };
  /** WebRTC may not send UDP, which would pass the proxy; its TCP goes through the proxy. */
  readonly args: string[];
  readonly executablePath?: string;
  readonly viewport: { readonly width: number; readonly height: number };
};

export type BrowserOptions = {
  /** The chat's state directory; profiles go under `<profileRoot>/browser/`. */
  readonly profileRoot: string;
  /** Chromium executable (`PI_DURABLE_CHROMIUM`); Playwright's own download otherwise. */
  readonly executablePath?: string;
  /** Launches one persistent context; tests inject it. Default: `chromium.launchPersistentContext`. */
  readonly launch?: (profileDir: string, options: BrowserLaunchOptions) => Promise<BrowserContext>;
  /** Per operation, queue wait included. Default `OPERATION_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * Which browser and profile a calling conversation uses; the host maps every session of an agent to its name.
   * A key that is not a plain name (`BROWSER_KEY`) falls back to the conversation ID. Default: the conversation ID.
   */
  readonly keyOf?: (conversationId: ConversationId, context: Context) => Promise<string>;
  /**
   * Whether the browser of `key` (the `keyOf` result: an agent's name) may open loopback and private addresses only,
   * never public ones, so an agent that can also read files cannot send them to the internet. Asked once per key, when
   * its browser is first used. Default: no browser is local-only.
   */
  readonly localOnly?: (key: string) => boolean;
  /** Resolves hosts for the egress check; tests inject it. Default: `node:dns`, every address. */
  readonly lookup?: Lookup;
  /** Tests only: the address the egress proxy connects to for one it checked. Default: that address. */
  readonly connectAddress?: (address: string) => string;
};

/** A browser key that is safe as a folder name: an agent name (`AGENT_NAME`) or a conversation ID. */
export const BROWSER_KEY = /^(?:[A-Za-z][A-Za-z0-9_-]{0,31}|\d+)$/;

export type BrowserExtension = Extension & {
  readonly tools: readonly ToolRegistration[];
  /** Close every browser; the extension relaunches on the next call. */
  close(): Promise<void>;
  /** Close `key`'s browser and delete its profile, logins included: for a deleted agent, whose name may be reused. */
  forget(key: string): Promise<void>;
};

type ConsoleEntry = { ts: number; type: string; text: string; location?: string };
type NetEntry = {
  ts: number; method: string; url: string; status?: number; statusText?: string; resourceType: string;
  requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>; failure?: string;
};

function pushBounded<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

/** One key's (agent's) browser: its context, current page, buffers, and operation queue. */
type Browser = {
  readonly profileDir: string;
  readonly localOnly: boolean;
  /** Recent egress verdicts by host name, so one page's many requests resolve once; the proxy connects to their addresses. */
  readonly verdicts: Map<string, { readonly at: number; readonly check: Promise<EgressCheck> }>;
  /** Started with the first launch, closed by `close()`. */
  proxy: Promise<EgressProxy> | null;
  /** Refusals by the proxy, by host (`host:port`), for the rows and results the routes did not refuse. */
  readonly proxyRefusals: Map<string, { readonly at: number; readonly refusal: string }>;
  /** The reason each refused request was aborted, for `browser_network`. */
  readonly refusals: WeakMap<Request, string>;
  /** The last refused navigation request, for `browser_goto` (a redirect to a refused address). */
  navigationRefusal: string | undefined;
  context: BrowserContext | null;
  page: Page | null;
  /** Bumped by teardown, so a launch that finishes after it closes what it launched. */
  generation: number;
  tail: Promise<unknown>;
  readonly console: ConsoleEntry[];
  readonly network: NetEntry[];
  readonly watched: WeakSet<Page>;
};

/**
 * A launch failure for lack of a Chromium executable, with this installation's fix: Playwright's own text tells the user
 * to run `npx playwright install`, a package this one does not have. Any other failure as it is.
 */
function launchError(error: unknown, executablePath: string | undefined): unknown {
  const message = errorMessage(error);
  if (!/executable doesn't exist/i.test(message)) return error;
  if (executablePath) {
    return new Error(`PI_DURABLE_CHROMIUM names ${executablePath}, which does not exist. The user can fix the path, or unset it to use Playwright's Chromium.`,
      { cause: error });
  }
  return new Error(`Chromium for the browser tools is not installed (${message.split('\n')[0] ?? ''}). The user can run `
    + 'npx --no-install playwright-core install chromium in the installation directory, or set PI_DURABLE_CHROMIUM to a Chromium executable.',
    { cause: error });
}

const result = (text: string, details: JsonValue = {}, isError = false): ToolExecutionResult =>
  ({ output: [{ type: 'text', text }], details, ...(isError ? { isError } : {}) });

export function createBrowserExtension(options: BrowserOptions): BrowserExtension {
  const launch = options.launch ?? ((dir, launchOptions) => chromium.launchPersistentContext(dir, launchOptions));
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const browsers = new Map<string, Browser>();

  const keyOf = options.keyOf ?? ((conversationId: ConversationId) => Promise.resolve(String(conversationId)));

  const browserFor = async (conversationId: ConversationId, context: Context): Promise<Browser> => {
    const resolved = await keyOf(conversationId, context);
    const key = BROWSER_KEY.test(resolved) ? resolved : String(conversationId);
    let browser = browsers.get(key);
    if (!browser) {
      browser = {
        profileDir: join(options.profileRoot, 'browser', key), localOnly: options.localOnly?.(key) ?? false,
        verdicts: new Map(), proxy: null, proxyRefusals: new Map(), refusals: new WeakMap(), navigationRefusal: undefined, context: null, page: null, generation: 0,
        tail: Promise.resolve(), console: [], network: [], watched: new WeakSet(),
      };
      browsers.set(key, browser);
    }
    return browser;
  };

  const lookup = options.lookup ?? lookupAll;

  /** `egressCheck` for `url`, its host's verdict reused for a few seconds. */
  const checkFor = (browser: Browser, url: string): Promise<EgressCheck> => {
    let host: string;
    try { host = new URL(url).hostname; } catch { return egressCheck(url, browser.localOnly, lookup); }
    const now = Date.now();
    const cached = browser.verdicts.get(host);
    if (cached && now - cached.at < VERDICT_TTL_MS) return cached.check;
    if (browser.verdicts.size > 256) browser.verdicts.clear();
    const check = egressCheck(url, browser.localOnly, lookup);
    browser.verdicts.set(host, { at: now, check });
    return check;
  };
  const refusalFor = async (browser: Browser, url: string): Promise<string | undefined> => (await checkFor(browser, url)).refusal;

  const proxyFor = (browser: Browser): Promise<EgressProxy> => {
    browser.proxy ??= startEgressProxy({
      check: (url) => checkFor(browser, url),
      refused: (url, refusal) => {
        let host = url;
        try { host = new URL(url).host; } catch { /* keep it whole */ }
        if (browser.proxyRefusals.size > 256) browser.proxyRefusals.clear();
        browser.proxyRefusals.set(host, { at: Date.now(), refusal });
      },
      ...(options.connectAddress ? { connectAddress: options.connectAddress } : {}),
    });
    const started = browser.proxy;
    started.catch(() => { if (browser.proxy === started) browser.proxy = null; });
    return started;
  };

  /** The proxy's recent refusal of `url`'s host, if any. */
  const proxyRefusal = (browser: Browser, url: string, since = 0): string | undefined => {
    let host: string;
    try { host = new URL(url).host; } catch { return undefined; }
    const hit = browser.proxyRefusals.get(host) ?? browser.proxyRefusals.get(`${host}:${new URL(url).protocol === 'http:' ? 80 : 443}`);
    return hit && hit.at >= since && Date.now() - hit.at < VERDICT_TTL_MS * 6 ? hit.refusal : undefined;
  };

  /** The context's gate for every request: aborted with its reason when refused, else continued. */
  async function guardRequest(browser: Browser, route: Route): Promise<void> {
    const request = route.request();
    try {
      const refusal = await refusalFor(browser, request.url());
      if (!refusal) { await route.continue(); return; }
      browser.refusals.set(request, refusal);
      if (request.isNavigationRequest()) browser.navigationRefusal = refusal;
      await route.abort('blockedbyclient');
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  }

  /** The gate for WebSockets: connected to the server when allowed, closed with the reason (in `browser_network`) when not. */
  async function guardSocket(browser: Browser, socket: WebSocketRoute): Promise<void> {
    const url = socket.url();
    const refusal = await refusalFor(browser, url).catch(() => 'Refused: the address check failed.');
    if (!refusal) { socket.connectToServer(); return; }
    pushBounded(browser.network, { ts: Date.now(), method: 'GET', url, resourceType: 'websocket', failure: refusal });
    await socket.close({ code: 1008, reason: 'Refused by the browser\'s egress policy' });
  }

  const teardown = async (browser: Browser): Promise<void> => {
    browser.generation++;
    const context = browser.context;
    browser.context = null;
    browser.page = null;
    try { await context?.close(); } catch { /* best effort */ }
  };

  function watch(browser: Browser, page: Page): void {
    if (browser.watched.has(page)) return;
    browser.watched.add(page);
    page.on('console', (message: ConsoleMessage) => {
      const location = message.location();
      pushBounded(browser.console, {
        ts: Date.now(), type: message.type(), text: redactText(message.text()),
        ...(location.url ? { location: `${redactUrl(location.url)}:${location.lineNumber}` } : {}),
      });
    });
    page.on('pageerror', (error) => {
      pushBounded(browser.console, { ts: Date.now(), type: 'pageerror', text: redactText(`${error.name}: ${error.message}`) });
    });
    page.on('requestfinished', (request: Request) => {
      void request.response().then((response) => {
        const refusal = response?.headers()[REFUSED_HEADER];
        if (refusal) {
          pushBounded(browser.network, {
            ts: Date.now(), method: request.method(), url: request.url(), resourceType: request.resourceType(), failure: refusal,
          });
          return;
        }
        pushBounded(browser.network, {
          ts: Date.now(), method: request.method(), url: request.url(), resourceType: request.resourceType(),
          requestHeaders: request.headers(),
          ...(response ? { status: response.status(), statusText: response.statusText(), responseHeaders: response.headers() } : {}),
        });
      }, () => { /* aborted with its page */ });
    });
    page.on('requestfailed', (request: Request) => {
      const failure = browser.refusals.get(request) ?? proxyRefusal(browser, request.url()) ?? request.failure()?.errorText;
      pushBounded(browser.network, {
        ts: Date.now(), method: request.method(), url: request.url(), resourceType: request.resourceType(),
        ...(failure ? { failure } : {}),
      });
    });
  }

  async function ensurePage(browser: Browser): Promise<Page> {
    if (browser.page && !browser.page.isClosed()) return browser.page;
    if (!browser.context) {
      const generation = browser.generation;
      const [, { server, username, password }] = await Promise.all([mkdir(browser.profileDir, { recursive: true, mode: 0o700 }), proxyFor(browser)]);
      const launched = await launch(browser.profileDir, {
        headless: true, chromiumSandbox: true, serviceWorkers: 'block', viewport: { width: 1280, height: 800 },
        proxy: { server, username, password }, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      }).catch((error: unknown) => { throw launchError(error, options.executablePath); });
      try {
        // Before any page loads: the gates must see the first request.
        await Promise.all([launched.route('**/*', (route) => guardRequest(browser, route)),
          launched.routeWebSocket(() => true, (socket) => guardSocket(browser, socket))]);
      } catch (error) {
        await launched.close().catch(() => undefined);
        throw error;
      }
      if (generation !== browser.generation) {
        await launched.close().catch(() => undefined);
        throw new Error('Browser launch cancelled');
      }
      browser.context = launched;
      launched.on('close', () => {
        if (browser.context === launched) { browser.context = null; browser.page = null; }
      });
      launched.on('page', (page) => watch(browser, page));
      for (const page of launched.pages()) watch(browser, page);
    }
    browser.page = browser.context.pages().find((page) => !page.isClosed()) ?? await browser.context.newPage();
    watch(browser, browser.page);
    return browser.page;
  }

  /**
   * Run `work` in the browser's queue, within the timeout. A timeout or an abort rejects at once, closes the browser
   * (which fails the running operation), and keeps `work` from starting if it is still queued.
   */
  async function run<T>(conversationId: ConversationId, context: Context, work: (browser: Browser) => Promise<T>): Promise<T> {
    const signal = context.abortSignal;
    if (signal?.aborted) throw new Error('Browser operation cancelled');
    const browser = await browserFor(conversationId, context);
    if (signal?.aborted) throw new Error('Browser operation cancelled');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = (reject: (error: Error) => void, message: string) => {
      if (stopped) return;
      stopped = true;
      void teardown(browser);
      reject(new Error(message));
    };
    const queued = browser.tail.then(() => {
      if (stopped) throw new Error('Browser operation cancelled');
      return work(browser);
    });
    browser.tail = queued.catch(() => undefined);
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => stop(reject, `Browser operation timed out after ${Math.round(timeoutMs / 1000)} s. `
        + 'The browser was closed, so its page is gone: start again with browser_goto (the profile keeps its logins).'), timeoutMs);
      onAbort = () => stop(reject, 'Browser operation cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([queued, limit]);
    } finally {
      stopped = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  const goto = defineTool({
    name: 'browser_goto',
    description: 'Navigate your persistent headless Chromium to an http(s) URL; returns the HTTP status and final URL. '
      + 'Cookies and localStorage persist across calls. Loopback and private addresses work; link-local (cloud metadata), '
      + 'CGNAT and Tailscale addresses are refused for every request the page makes, as are public ones when your browser '
      + 'is local-only. To debug a web app (failed requests, auth, JS errors, a form or '
      + 'a blank screen), drive the live app with browser_goto, browser_eval, browser_console and browser_network instead '
      + 'of asking the user to copy from devtools; after a frontend change, exercise it with browser_click and browser_fill.',
    parameters: obj({
      url: str({ description: 'URL to navigate to' }),
      waitUntil: opt(union([
        literal('load'), literal('domcontentloaded'), literal('networkidle'), literal('commit'),
      ])),
      timeoutMs: opt(num()),
    }, { open: true }),
    executionMode: 'sequential',
    execute: ({ url, waitUntil, timeoutMs: navigationTimeout }, api, context) => run(api.conversationId, context, async (browser) => {
      const target = httpUrl(url);
      const refused = (refusal: string) => result(refusal, { status: null, refused: refusal }, true);
      const early = await refusalFor(browser, target.href);
      if (early) return refused(early);
      const page = await ensurePage(browser);
      browser.navigationRefusal = undefined;
      const started = Date.now();
      const latestProxyRefusal = (): string | undefined => {
        let latest: { readonly at: number; readonly refusal: string } | undefined;
        for (const hit of browser.proxyRefusals.values()) if (hit.at >= started && (!latest || hit.at >= latest.at)) latest = hit;
        return latest?.refusal;
      };
      let response;
      try {
        response = await page.goto(target.href, { waitUntil: waitUntil ?? 'domcontentloaded', timeout: navigationTimeout ?? 30_000 });
      } catch (error) {
        // A hop a gate refused fails the navigation: say why rather than net::ERR_BLOCKED_BY_CLIENT or a tunnel error.
        const refusal = browser.navigationRefusal ?? latestProxyRefusal();
        if (refusal) return refused(refusal);
        throw error;
      }
      // The routes do not see redirect hops; the proxy refuses a plain-HTTP one with a 403 that names the reason.
      const proxied = response?.headers()[REFUSED_HEADER];
      if (proxied) return refused(proxied);
      const status = response?.status() ?? null;
      const finalUrl = redactUrl(page.url());
      return result(`${status ?? '?'} ${finalUrl}`, { status, finalUrl });
    }),
  });

  const evaluate = defineTool({
    name: 'browser_eval',
    description: 'Evaluate JavaScript in the current page: an expression (\'localStorage.length\'), a function '
      + '(\'() => Object.keys(localStorage)\', \'async () => { ... }\'), or an already-called IIFE. The value must be '
      + 'JSON-serializable: for DOM nodes return properties such as .outerHTML, .textContent or .value. Use it to read '
      + 'runtime state (storage, cookies, JWTs, component state, computed styles) or to fire a fetch with custom headers. '
      + 'Its result is stored in the chat unredacted: do not return secrets you do not need.',
    parameters: obj({ expression: str({ description: 'Expression or function source' }) }, { open: true }),
    executionMode: 'sequential',
    execute: ({ expression }, api, context) => run(api.conversationId, context, async (browser) => {
      const page = await ensurePage(browser);
      let value: unknown;
      try {
        value = await page.evaluate<unknown>(evalSource(expression));
      } catch (error) {
        return result(`eval error: ${errorMessage(error)}`, {}, true);
      }
      const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
      const truncated = text.length > EVAL_LIMIT;
      return result(truncated ? `${text.slice(0, EVAL_LIMIT)}\n[Output truncated at 50,000 characters]` : text, { truncated });
    }),
  });

  const consoleTool = defineTool({
    name: 'browser_console',
    description: 'Drain buffered console and pageerror entries, oldest first. With clear=true (default) the ENTIRE buffer is '
      + 'wiped after the read, not just the entries returned, so the next call sees fresh activity; clear=false peeks. '
      + 'Reach for it whenever a page seems broken without an obvious network cause.',
    parameters: obj({
      limit: opt(num({ description: 'Max entries (default 100)' })),
      filter: opt(str({ description: 'Only entries whose text or location contains this substring' })),
      clear: opt(bool({ description: 'Clear the entire buffer after the read. Default true.' })),
    }, { open: true }),
    executionMode: 'sequential',
    execute: ({ limit, filter, clear }, api, context) => run(api.conversationId, context, (browser) => {
      const buffer = browser.console;
      const matching = filter ? buffer.filter((e) => e.text.includes(filter) || (e.location ?? '').includes(filter)) : buffer.slice();
      const out = matching.slice(-(limit ?? 100));
      if (clear ?? true) buffer.length = 0;
      const text = out.map((e) => `[${new Date(e.ts).toISOString()}] ${e.type}: ${e.text}${e.location ? `  @ ${e.location}` : ''}`)
        .join('\n') || '(empty)';
      return Promise.resolve(result(text, { count: out.length }));
    }),
  });

  const network = defineTool({
    name: 'browser_network',
    description: 'Drain buffered network requests, one terse line each (\'<status> <method> <url>\'). verbose=true adds a '
      + `curated set of request and response headers (${[...KEEP_HEADERS].join(', ')}); includeHeaders adds more for this `
      + 'call (case-insensitive). Authorization, cookie, API key, token and secret values are redacted, as are a '
      + 'location\'s query and fragment and URL parameters such as code= or access_token=. Pair headers with '
      + 'urlFilter or status; use it for 401, 403 and CORS issues. With clear=true (default) the ENTIRE buffer is wiped '
      + 'after the read; clear=false peeks. A fetch whose body is never consumed often shows as ERR net::ERR_ABORTED even '
      + 'though the page saw a response: consume the body for a clean row.',
    parameters: obj({
      limit: opt(num()),
      urlFilter: opt(str({ description: 'Substring filter on URL' })),
      status: opt(num({ description: 'Exact HTTP status to match' })),
      verbose: opt(bool({ description: 'Show the curated request and response headers on each row.' })),
      includeHeaders: opt(arr(str(), {
        description: 'Extra header names (case-insensitive) to show besides the curated set. Implies verbose=true.',
      })),
      clear: opt(bool({ description: 'Clear the entire buffer after the read. Default true.' })),
    }, { open: true }),
    executionMode: 'sequential',
    execute: ({ limit, urlFilter, status, verbose, includeHeaders, clear }, api, context) => run(api.conversationId, context, (browser) => {
      let entries = browser.network.slice();
      if (urlFilter) entries = entries.filter((e) => e.url.includes(urlFilter));
      if (status !== undefined) entries = entries.filter((e) => e.status === status);
      const out = entries.slice(-(limit ?? 100));
      if (clear ?? true) browser.network.length = 0;
      const extra = (includeHeaders ?? []).map((name) => name.toLowerCase());
      const showHeaders = verbose === true || extra.length > 0;
      const allow = new Set([...KEEP_HEADERS, ...extra]);
      const lines: string[] = [];
      for (const e of out) {
        lines.push(`${e.status ?? 'ERR'} ${e.method} ${redactUrl(e.url)}${e.failure ? `  (${e.failure})` : ''}`);
        if (!showHeaders) continue;
        for (const [name, value] of Object.entries(filterHeaders(e.requestHeaders ?? {}, allow))) lines.push(`  → ${name}: ${value}`);
        for (const [name, value] of Object.entries(filterHeaders(e.responseHeaders ?? {}, allow))) lines.push(`  ← ${name}: ${value}`);
      }
      return Promise.resolve(result(lines.join('\n') || '(empty)', { count: out.length }));
    }),
  });

  const fill = defineTool({
    name: 'browser_fill',
    description: 'Type a value into the input matching the selector; dispatches input and change events, unlike assigning .value.',
    parameters: obj({ selector: str(), value: str() }, { open: true }),
    executionMode: 'sequential',
    execute: ({ selector, value }, api, context) => run(api.conversationId, context, async (browser) => {
      await (await ensurePage(browser)).fill(selector, value);
      return result(`filled ${selector}`);
    }),
  });

  const click = defineTool({
    name: 'browser_click',
    description: 'Click the element matching the selector, as a user would (form submits, SPA navigation). CSS selectors and '
      + 'Playwright text= and role= selectors work. CSS attribute selectors match HTML attributes, not DOM properties: '
      + '`button[type=submit]` does NOT match `<button>Submit</button>`; prefer `text=Submit` or `role=button[name=Submit]`.',
    parameters: obj({ selector: str() }, { open: true }),
    executionMode: 'sequential',
    execute: ({ selector }, api, context) => run(api.conversationId, context, async (browser) => {
      await (await ensurePage(browser)).click(selector);
      return result(`clicked ${selector}`);
    }),
  });

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture a PNG of the current page and return it as an image, for when DOM and state inspection are not '
      + 'enough. fullPage captures the whole scrollable page, up to 8 megapixels.',
    parameters: obj({ fullPage: opt(bool()) }, { open: true }),
    executionMode: 'sequential',
    execute: ({ fullPage }, api, context) => run(api.conversationId, context, async (browser) => {
      const page = await ensurePage(browser);
      if (fullPage) {
        const size = await page.evaluate<{ width: number; height: number }>(
          '({ width: Math.max(document.documentElement.scrollWidth, innerWidth), '
          + 'height: Math.max(document.documentElement.scrollHeight, innerHeight) })');
        if (size.width * size.height > MAX_FULL_PAGE_PIXELS) throw new Error('Full-page capture exceeds 8 megapixels; use a viewport screenshot.');
      }
      const image = await page.screenshot({ fullPage: fullPage ?? false, type: 'png', timeout: 30_000 });
      if (image.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot exceeds 16 MB; try a viewport capture.');
      return {
        output: [
          { type: 'text', text: `Screenshot of ${redactUrl(page.url())}` },
          { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
        ],
        details: { bytes: image.length, url: redactUrl(page.url()) },
      };
    }),
  });

  const close = defineTool({
    name: 'browser_close',
    description: 'Close your browser. The next browser_* call relaunches it with the same profile.',
    parameters: obj({}, { open: true }),
    executionMode: 'sequential',
    execute: (_args, api, context) => run(api.conversationId, context, async (browser) => {
      await teardown(browser);
      return result('browser closed');
    }),
  });

  const shut = async (browser: Browser): Promise<void> => {
    await teardown(browser);
    const proxy = browser.proxy;
    browser.proxy = null;
    (await proxy?.catch(() => undefined))?.close();
  };

  return {
    name: BROWSER_EXTENSION,
    tools: [goto, evaluate, consoleTool, network, fill, click, screenshot, close],
    close: async () => {
      await Promise.all([...browsers.values()].map(shut));
    },
    forget: async (key) => {
      // Only a safe key names a folder under the profile root; anything else was never one.
      if (!BROWSER_KEY.test(key)) return;
      const browser = browsers.get(key);
      browsers.delete(key);
      if (browser) await shut(browser);
      await rm(join(options.profileRoot, 'browser', key), { recursive: true, force: true });
    },
  };
}
