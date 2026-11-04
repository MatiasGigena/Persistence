// Online backups (ADR 0022): the database through `VACUUM INTO`, then the memory directory and settings.json copied,
// all in one synchronous step of the writer, so no commit or memory append lands between them. The running server
// does it for `admin.backup`; without a server, `pi-durable backup` takes the flock and does it itself.
// Browser profiles (`<memory>/browser/`, src/tools/browser.ts) are left out: they hold the agents' login cookies, and
// Chromium writes them outside the writer's queue, so a copy could be torn; a lost one costs a login.
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorCode } from '../protocol/util.ts';

/** How long backups are kept: older stamped directories are deleted after each backup. */
export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** What a backup copies: a chat's files (statePaths). */
export interface BackupSource {
  readonly databasePath: string;
  readonly memoryDir: string;
  readonly settingsPath: string;
}

/** A finished backup: its directory and the bytes it holds. */
export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
}

/** Runs one synchronous step with the database connection, as the writer: `Instance.exclusive`, or a direct open. */
export type Exclusive = <T>(step: (database: DatabaseSync) => T) => Promise<T>;

/** The default parent of backups: `backups/` beside the database (the data dir, in the default layout). */
export const backupRoot = (databasePath: string): string => join(dirname(databasePath), 'backups');

/** A backup directory's name: the UTC time, ISO 8601 without colons (`2026-10-19T03-00-00Z`), sortable. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-\d+)?$/;

/** The time in a stamped directory name, or undefined for any other name. */
export function stampTime(name: string): number | undefined {
  const match = STAMP.exec(name);
  if (!match) return undefined;
  const time = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}:${match[3] ?? ''}:${match[4] ?? ''}Z`);
  return Number.isNaN(time) ? undefined : time;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The memory directory's entry that holds the browser profiles (src/tools/browser.ts): never backed up. */
export const BROWSER_PROFILES = 'browser';

/**
 * Copies `from` (a directory or a file) to `to`, fsyncing every file and directory, except the entries of `from`
 * named in `skip`; returns the bytes copied.
 */
function copyDurably(from: string, to: string, skip: ReadonlySet<string> = new Set()): number {
  const info = lstatSync(from);
  if (info.isFile()) {
    copyFileSync(from, to);
    fsyncPath(to);
    return info.size;
  }
  if (!info.isDirectory()) return 0;
  mkdirSync(to, { mode: 0o700 });
  let bytes = 0;
  for (const name of readdirSync(from)) if (!skip.has(name)) bytes += copyDurably(join(from, name), join(to, name));
  fsyncPath(to);
  return bytes;
}

/**
 * The synchronous step: `VACUUM INTO <dir>/<database name>`, then the memory directory (without its browser profiles)
 * and settings.json copied beside it. `dir` must exist and be empty.
 */
export function snapshotInto(database: DatabaseSync, source: BackupSource, dir: string): number {
  const target = join(dir, basename(source.databasePath));
  database.prepare('VACUUM INTO ?').run(target);
  fsyncPath(target);
  let bytes = statSync(target).size;
  if (existsSync(source.memoryDir)) bytes += copyDurably(source.memoryDir, join(dir, basename(source.memoryDir)), new Set([BROWSER_PROFILES]));
  if (existsSync(source.settingsPath)) bytes += copyDurably(source.settingsPath, join(dir, basename(source.settingsPath)));
  fsyncPath(dir);
  return bytes;
}

/**
 * Writes a backup of `source` into a new stamped directory under `out` (default `backupRoot`), through `exclusive`,
 * then deletes stamped directories under `out` older than `KEEP_MS`. Resolves with the new directory and its size.
 */
export async function backup(source: BackupSource, exclusive: Exclusive, { out, now = new Date() }: {
  readonly out?: string; readonly now?: Date;
} = {}): Promise<BackupResult> {
  const root = out ?? backupRoot(source.databasePath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let path = join(root, stamp(now));
  // Two backups in one second get distinct directories.
  for (let n = 2; ; n++) {
    try { await mkdir(path, { mode: 0o700 }); break; } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      path = join(root, `${stamp(now)}-${n}`);
    }
  }
  try {
    const bytes = await exclusive(database => snapshotInto(database, source, path));
    fsyncPath(root);
    await prune(root, { now: now.getTime() });
    return { path, bytes };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Deletes the stamped backup directories under `root` older than `keepMs`; any other entry is left alone.
 * Resolves with the names deleted.
 */
export async function prune(root: string, { now = Date.now(), keepMs = KEEP_MS }: { readonly now?: number; readonly keepMs?: number } = {}): Promise<string[]> {
  let names: string[];
  try { names = await readdir(root); } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const old = names.filter(name => {
    const time = stampTime(name);
    return time !== undefined && now - time > keepMs;
  });
  await Promise.all(old.map(name => rm(join(root, name), { recursive: true, force: true })));
  return old;
}

/** A backup without a server: the caller holds the database's flock, so this process is the only writer. */
export async function backupOffline(source: BackupSource, options: { readonly out?: string; readonly now?: Date } = {}): Promise<BackupResult> {
  if (!existsSync(source.databasePath)) throw new Error(`No chat to back up at ${source.databasePath}`);
  const database = new DatabaseSync(source.databasePath, { timeout: 5_000 });
  try {
    return await backup(source, step => Promise.resolve(step(database)), options);
  } finally {
    database.close();
  }
}
