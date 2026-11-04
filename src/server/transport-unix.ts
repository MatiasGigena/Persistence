// The Unix socket transport (docs/protocol.md "Transports"): NDJSON, one message per line, on a mode 600 socket
// beside the database. Each connection goes to the hub as a PeerLink of peer `socket`.
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { errorCode } from '../protocol/util.ts';
import { ErrorCode, LIMITS } from '../protocol/messages.ts';
import type { Bye, ErrorResponse } from '../protocol/messages.ts';
import type { PeerHub, PeerLink } from './link.ts';

/** How long a closing link waits for its peer to read the `bye` before cutting it off. */
const CLOSE_GRACE_MS = 1_000;

export interface UnixListener {
  readonly path: string;
  /** Stops listening, cuts off links still open (the hub has sent them `bye`), and removes the socket file. */
  close(): Promise<void>;
}

/**
 * Splits a byte stream into lines: `line` gets each one without its newline; a line longer than `max` code units is
 * skipped up to its newline, and `tooLong` is called once for it instead.
 */
export function lineSplitter(max: number, line: (text: string) => void, tooLong: () => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let partial = '', skipping = false;
  return chunk => {
    let text = decoder.write(chunk);
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n')) {
      const head = text.slice(0, at);
      text = text.slice(at + 1);
      if (skipping) { skipping = false; partial = ''; continue; }
      const whole = (partial + head).replace(/\r$/, '');
      partial = '';
      if (whole.length > max) tooLong();
      else if (whole.trim()) line(whole);
    }
    if (skipping) return;
    partial += text;
    if (partial.length > max) { partial = ''; skipping = true; tooLong(); }
  };
}

/** A connected socket as a PeerLink. */
function socketLink(socket: Socket): PeerLink {
  let deliver: ((text: string) => void) | undefined;
  let closed: (() => void) | undefined;
  const early: string[] = [];
  let gone = false, ending = false;
  const write = (text: string): void => { if (!ending && !socket.destroyed) socket.write(`${text}\n`); };
  socket.on('data', lineSplitter(LIMITS.clientMessage, text => {
    if (deliver) deliver(text);
    else early.push(text);
  }, () => {
    const answer: ErrorResponse = { t: 'res', id: -1, ok: false,
      error: { code: ErrorCode.badRequest, message: `A message may be at most ${LIMITS.clientMessage} characters.` } };
    write(JSON.stringify(answer));
  }));
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    gone = true;
    closed?.();
  });
  return {
    peer: 'socket',
    who: 'socket',
    send: write,
    buffered: () => socket.writableLength,
    close(code, reason) {
      if (ending || socket.destroyed) return;
      const bye: Bye = { t: 'bye', code, reason };
      write(JSON.stringify(bye));
      ending = true;
      socket.end();
      // A peer that stopped reading never lets `end` finish.
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    },
    onMessage(listener) {
      deliver = listener;
      for (const text of early.splice(0)) listener(text);
    },
    onClose(listener) {
      if (gone) queueMicrotask(listener);
      else closed = listener;
    },
  };
}

/**
 * Listens on the Unix socket `path` (mode 600) and hands each connection to `hub`. A file already at `path` is a
 * stale socket of an earlier server, since the caller holds the database's flock: it is removed. Anything other
 * than a socket there is refused.
 */
export async function listenUnix(path: string, hub: PeerHub): Promise<UnixListener> {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error(`${path} exists and is not a socket; move it away`);
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    hub.attach(socketLink(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  // umask 077 already makes it 700; 600 is what the protocol says.
  await chmod(path, 0o600);
  return {
    path,
    async close() {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      const pending = [...sockets].filter(socket => !socket.destroyed);
      await Promise.race([
        Promise.all(pending.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))),
        new Promise<void>(resolve => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
      ]);
      for (const socket of sockets) socket.destroy();
      await stopped;
      try { await unlink(path); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    },
  };
}
