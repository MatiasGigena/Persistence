// Durable file writes for the state the host keeps beside the database: settings, the server's stores and the
// memory directory. Both fsync before returning, so a crash right after never leaves a torn file.
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';

/** Append JSON lines in one write and fsync them before returning. */
export function appendJson(file: string, ...values: unknown[]): void {
  const fd = openSync(file, 'a', 0o600);
  try {
    const data = Buffer.from(values.map(value => `${JSON.stringify(value)}\n`).join(''));
    if (writeSync(fd, data) !== data.length) throw new Error(`Incomplete write: ${file}`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Replace `file` with `content` (mode 0600): written to a temporary file, fsynced, then renamed over it. */
export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
