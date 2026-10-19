// The web app's files (ADR 0020): src/web/ at `/`, src/protocol/ at `/protocol/`, src/ui/types.ts at
// `/ui/types.ts`, and marked's ESM build at `/vendor/`. TypeScript is type-stripped at request time.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorCode } from '../host/config.ts';

/** Where each URL prefix is served from. */
export interface StaticRoots {
  /** `/`: the app (src/web/). */
  readonly web: string;
  /** `/protocol/`: src/protocol/. */
  readonly protocol: string;
  /** `/ui/types.ts`: the one file of src/ui/ the browser may need. */
  readonly uiTypes: string;
  /** `/vendor/`: marked's lib/ directory; only its ESM build and source map are served. */
  readonly marked: string;
}

const SRC = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_ROOTS: StaticRoots = {
  web: join(SRC, 'web'),
  protocol: join(SRC, 'protocol'),
  uiTypes: join(SRC, 'ui', 'types.ts'),
  marked: fileURLToPath(new URL('../../node_modules/marked/lib', import.meta.url)),
};
const VENDOR = new Set(['marked.esm.js', 'marked.esm.js.map']);

/** The extensions served, and their types; anything else is 404. */
const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.ts', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'],
  ['.map', 'application/json'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);
/** Never served even with an allowed extension: the type-checker's configs. */
const HIDDEN = new Set(['tsconfig.json']);

const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** The `script-src` hashes of index.html's inline import maps (CSP allows no other inline script). */
export function importMapHashes(html: string): string[] {
  return [...html.matchAll(IMPORT_MAP)].map(([, body = '']) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
}

/** The Content-Security-Policy for an app at `origin` whose index.html is `html`. */
export function contentSecurityPolicy(origin: string, html: string): string {
  const socket = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    `script-src 'self' ${importMapHashes(html).join(' ')}`.trim(),
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${socket}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Headers on every response of the web listener. */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The file a URL path names, or undefined: a decoded path under one of the roots, with an allowed extension,
 * no dot-segment or hidden name, and (after symlinks) still under its root.
 */
export async function resolveFile(roots: StaticRoots, pathname: string): Promise<string | undefined> {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return undefined; }
  if (!path.startsWith('/') || /[\0\\]/.test(path)) return undefined;
  if (path === '/') path = '/index.html';
  const parts = path.slice(1).split('/');
  if (parts.some(part => part === '' || part.startsWith('.')) || HIDDEN.has(parts.at(-1) ?? '')) return undefined;
  let root: string, file: string;
  if (path === '/ui/types.ts') [root, file] = [roots.uiTypes, roots.uiTypes];
  else if (parts[0] === 'protocol') [root, file] = [roots.protocol, resolve(roots.protocol, ...parts.slice(1))];
  else if (parts[0] === 'vendor') {
    if (parts.length !== 2 || !VENDOR.has(parts[1] ?? '')) return undefined;
    [root, file] = [roots.marked, resolve(roots.marked, ...parts.slice(1))];
  } else [root, file] = [roots.web, resolve(roots.web, ...parts)];
  if (!TYPES.has(extname(file)) || !inside(root, file)) return undefined;
  try {
    const [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    return inside(realRoot, real) && (await stat(real)).isFile() ? real : undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

interface Entry { readonly mtimeMs: number; readonly size: number; readonly body: Buffer; readonly etag: string }

/** The web app's file server. */
export interface StaticFiles {
  /** Answers a GET or HEAD for an app file: 200, 304, or 404 when no app file has that path. */
  serve(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>;
  /** The current Content-Security-Policy (index.html's import map hash included). */
  csp(): string;
}

/** A file server for `roots`, with the CSP for `origin`; reads index.html now for its import map hash. */
export async function createStaticFiles(origin: string, roots: StaticRoots = DEFAULT_ROOTS): Promise<StaticFiles> {
  const cache = new Map<string, Entry>();
  const index = resolve(roots.web, 'index.html');
  let csp = contentSecurityPolicy(origin, '');

  /** The file's bytes as served, cached until its mtime or size changes. */
  async function load(file: string): Promise<Entry> {
    const info = await stat(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const raw = await readFile(file);
    const body = extname(file) === '.ts' ? Buffer.from(stripTypeScriptTypes(raw.toString('utf8'), { mode: 'strip' })) : raw;
    if (file === await realpath(index).catch(() => index)) csp = contentSecurityPolicy(origin, raw.toString('utf8'));
    const entry = { mtimeMs: info.mtimeMs, size: info.size, body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` };
    cache.set(file, entry);
    return entry;
  }

  try { await load(await realpath(index)); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }

  return {
    csp: () => csp,
    async serve(request, response, pathname) {
      const file = await resolveFile(roots, pathname);
      if (!file) {
        response.writeHead(404, { ...securityHeaders(csp), 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
        return;
      }
      const entry = await load(file);
      const headers = {
        ...securityHeaders(csp),
        'Content-Type': TYPES.get(extname(file)) ?? 'application/octet-stream',
        // No file is content-hashed (there is no build), so every one revalidates by ETag.
        'Cache-Control': 'no-cache',
        ETag: entry.etag,
      };
      if (request.headers['if-none-match'] === entry.etag) {
        response.writeHead(304, headers).end();
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Length': entry.body.length });
      response.end(request.method === 'HEAD' ? undefined : entry.body);
    },
  };
}

async function servedFiles(roots: StaticRoots): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    let names: Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const files = await Promise.all(names.filter(entry => !entry.name.startsWith('.')).map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && TYPES.has(extname(entry.name)) && !HIDDEN.has(entry.name) ? [path] : [];
    }));
    return files.flat();
  };
  const [web, protocol] = await Promise.all([walk(roots.web), walk(roots.protocol)]);
  return [...web, ...protocol, roots.uiTypes, ...[...VENDOR].map(name => join(roots.marked, name))];
}

/**
 * `welcome.assets`: a hash of every served file's path and bytes (sources, before stripping). A web client that
 * sees it change reloads. Missing files count as absent.
 */
export async function assetsHash(roots: StaticRoots = DEFAULT_ROOTS): Promise<string> {
  const hash = createHash('sha256');
  const base = resolve(roots.web, '..');
  for (const file of (await servedFiles(roots)).sort()) {
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    hash.update(`${relative(base, file)}\0${createHash('sha256').update(bytes).digest('hex')}\0`);
  }
  return hash.digest('base64url').slice(0, 16);
}
