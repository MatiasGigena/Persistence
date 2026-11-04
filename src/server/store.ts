// The server's small JSON files under serve/ (devices.json, push.json, vapid.json): mode 600, replaced atomically
// (written to a temporary file, fsynced, renamed, the directory fsynced), and read back through a parser that
// narrows `unknown` (the narrowers in src/protocol/util.ts). Only the server writes them, under the database's flock.
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode, errorMessage } from '../protocol/util.ts';
import { atomicWrite } from '../runtime/files.ts';

/** Replaces `file` with `value` as JSON (mode 600, directory mode 700), durably: the old or the new, never half. */
export function writeJson(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  // The rename is durable only once the directory is.
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The parsed contents of `file`, or `missing()` when it does not exist. Rejects, naming the file, when it is not
 * JSON or `parse` throws: a damaged file is the owner's to fix, never silently replaced.
 */
export async function readJson<T>(file: string, parse: (value: unknown) => T, missing: () => T): Promise<T> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (errorCode(error) === 'ENOENT') return missing();
    throw error;
  }
  try { return parse(JSON.parse(text)); } catch (error) {
    throw new Error(`${file} is damaged (${errorMessage(error)}); fix it, or delete it to start over`, { cause: error });
  }
}
