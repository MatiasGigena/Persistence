import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, JsonValue } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import type { ConversationId, Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { type BrowserContext, chromium, type ConsoleMessage, type Page, type Request } from 'playwright-core';

/**
 * Browser tools: a headless Chromium per agent, ported from Pi Cloud's `resources/extensions/browser` (ADR 0027).
 *
 * Each browser is keyed by `keyOf(conversationId)`: the host maps every session of an agent (a standing agent gets a new
 * conversation per task) to the agent's name, so the agent keeps one Chromium and one persistent profile,
 * `<profileRoot>/browser/<key>`, whose cookies and localStorage survive between calls, tasks and restarts. Each browser
 * has one queue: Playwright's Page is not safe for concurrent use, so a `goto` and an `eval` fired in one round must not
 * interleave, and two sessions of one agent running at once (rare) take turns on the same page. Each operation, queue wait included,
 * has 60 s; a timeout or an abort closes that browser, and the next call relaunches it. Navigation is HTTP(S) only;
 * loopback and private addresses are allowed, since the browser is for debugging the user's apps. Unlike Pi Cloud there
 * is no `/browser on` gate and no manual control from the web UI.
 *
 * pi-durable extensions have no shutdown hook, so the host calls `close()` when it closes the Harness.
 */

export const BROWSER_EXTENSION = 'browser';
/** Entries kept per buffer (console, network); older ones are dropped. */
export const MAX_BUFFER = 1000;
export const OPERATION_TIMEOUT_MS = 60_000;
const EVAL_LIMIT = 50_000;
const MAX_FULL_PAGE_PIXELS = 8_000_000;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

/** Headers `browser_network` shows with `verbose`; `includeHeaders` adds more for one call. */
export const KEEP_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'apikey', 'content-type', 'x-client-info', 'accept-profile', 'content-profile', 'prefer', 'location',
  'www-authenticate', 'retry-after',
]);
const SENSITIVE = /authorization|cookie|api[-_]?key|token|secret/i;
/** Query and fragment parameters whose values `redactUrl` hides. */
const SENSITIVE_PARAM = /token|code|secret|key|auth|session|password|sig/i;
const REDACTED = '[redacted]';

function redactParams(params: string): string {
  return params.split('&').map((pair) => {
    const at = pair.indexOf('=');
    if (at < 0) return pair;
    let name = pair.slice(0, at);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep it raw */ }
    return SENSITIVE_PARAM.test(name) ? `${pair.slice(0, at)}=${REDACTED}` : pair;
  }).join('&');
}

/** `url` (absolute or not) with the values of sensitive query and fragment parameters (`code=`, `#access_token=`) hidden. */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const before = hash < 0 ? url : url.slice(0, hash);
  const question = before.indexOf('?');
  const path = question < 0 ? before : `${before.slice(0, question)}?${redactParams(before.slice(question + 1))}`;
  return hash < 0 ? path : `${path}#${redactParams(url.slice(hash + 1))}`;
}

/** A `location` header with its whole query and fragment hidden: redirects carry OAuth codes and tokens there. */
export function redactLocation(url: string): string {
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

/**
 * Page source that evaluates `source` once and calls the value if it is a function, so an expression, a function
 * (`() => x`, `async () => {...}`) and an already-called IIFE all work. Wrapping by regex instead double-calls IIFEs.
 */
export const evalSource = (source: string): string =>
  `(() => { const __v = (${source}); return typeof __v === 'function' ? __v() : __v; })()`;

export type BrowserLaunchOptions = {
  readonly headless: true;
  readonly chromiumSandbox: true;
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
};

/** A browser key that is safe as a folder name: an agent name (`AGENT_NAME`) or a conversation ID. */
export const BROWSER_KEY = /^(?:[A-Za-z][A-Za-z0-9_-]{0,31}|\d+)$/;

export type BrowserExtension = Extension & {
  readonly tools: readonly ToolRegistration[];
  /** Close every browser; the extension relaunches on the next call. */
  close(): Promise<void>;
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
  context: BrowserContext | null;
  page: Page | null;
  /** Bumped by teardown, so a launch that finishes after it closes what it launched. */
  generation: number;
  tail: Promise<unknown>;
  readonly console: ConsoleEntry[];
  readonly network: NetEntry[];
  readonly watched: WeakSet<Page>;
};

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
        profileDir: join(options.profileRoot, 'browser', key), context: null, page: null, generation: 0,
        tail: Promise.resolve(), console: [], network: [], watched: new WeakSet(),
      };
      browsers.set(key, browser);
    }
    return browser;
  };

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
        ts: Date.now(), type: message.type(), text: message.text(),
        ...(location.url ? { location: `${redactUrl(location.url)}:${location.lineNumber}` } : {}),
      });
    });
    page.on('pageerror', (error) => {
      pushBounded(browser.console, { ts: Date.now(), type: 'pageerror', text: `${error.name}: ${error.message}` });
    });
    page.on('requestfinished', (request: Request) => {
      void request.response().then((response) => {
        pushBounded(browser.network, {
          ts: Date.now(), method: request.method(), url: request.url(), resourceType: request.resourceType(),
          requestHeaders: request.headers(),
          ...(response ? { status: response.status(), statusText: response.statusText(), responseHeaders: response.headers() } : {}),
        });
      }, () => { /* aborted with its page */ });
    });
    page.on('requestfailed', (request: Request) => {
      const failure = request.failure()?.errorText;
      pushBounded(browser.network, {
        ts: Date.now(), method: request.method(), url: request.url(), resourceType: request.resourceType(),
        ...(failure ? { failure } : {}),
      });
    });
  }

  async function ensurePage(browser: Browser): Promise<Page> {
    if (browser.page && !browser.page.isClosed()) return browser.page;
    if (!browser.context) {
      await mkdir(browser.profileDir, { recursive: true, mode: 0o700 });
      const generation = browser.generation;
      const launched = await launch(browser.profileDir, {
        headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 800 },
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
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
      timer = setTimeout(() => stop(reject, `Browser operation timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
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
      + 'Cookies and localStorage persist across calls. To debug a web app (failed requests, auth, JS errors, a form or '
      + 'a blank screen), drive the live app with browser_goto, browser_eval, browser_console and browser_network instead '
      + 'of asking the user to copy from devtools; after a frontend change, exercise it with browser_click and browser_fill.',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to navigate to' }),
      waitUntil: Type.Optional(Type.Union([
        Type.Literal('load'), Type.Literal('domcontentloaded'), Type.Literal('networkidle'), Type.Literal('commit'),
      ])),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    executionMode: 'sequential',
    execute: ({ url, waitUntil, timeoutMs: navigationTimeout }, api, context) => run(api.conversationId, context, async (browser) => {
      const target = httpUrl(url);
      const page = await ensurePage(browser);
      const response = await page.goto(target.href, { waitUntil: waitUntil ?? 'domcontentloaded', timeout: navigationTimeout ?? 30_000 });
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
    parameters: Type.Object({ expression: Type.String({ description: 'Expression or function source' }) }),
    executionMode: 'sequential',
    execute: ({ expression }, api, context) => run(api.conversationId, context, async (browser) => {
      const page = await ensurePage(browser);
      let value: unknown;
      try {
        value = await page.evaluate<unknown>(evalSource(expression));
      } catch (error) {
        return result(`eval error: ${error instanceof Error ? error.message : String(error)}`, {}, true);
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
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: 'Max entries (default 100)' })),
      filter: Type.Optional(Type.String({ description: 'Only entries whose text or location contains this substring' })),
      clear: Type.Optional(Type.Boolean({ description: 'Clear the entire buffer after the read. Default true.' })),
    }),
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
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      urlFilter: Type.Optional(Type.String({ description: 'Substring filter on URL' })),
      status: Type.Optional(Type.Number({ description: 'Exact HTTP status to match' })),
      verbose: Type.Optional(Type.Boolean({ description: 'Show the curated request and response headers on each row.' })),
      includeHeaders: Type.Optional(Type.Array(Type.String(), {
        description: 'Extra header names (case-insensitive) to show besides the curated set. Implies verbose=true.',
      })),
      clear: Type.Optional(Type.Boolean({ description: 'Clear the entire buffer after the read. Default true.' })),
    }),
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
    parameters: Type.Object({ selector: Type.String(), value: Type.String() }),
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
    parameters: Type.Object({ selector: Type.String() }),
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
    parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean()) }),
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
    parameters: Type.Object({}),
    executionMode: 'sequential',
    execute: (_args, api, context) => run(api.conversationId, context, async (browser) => {
      await teardown(browser);
      return result('browser closed');
    }),
  });

  return {
    name: BROWSER_EXTENSION,
    tools: [goto, evaluate, consoleTool, network, fill, click, screenshot, close],
    close: async () => { await Promise.all([...browsers.values()].map(teardown)); },
  };
}
