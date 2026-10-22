// A single stdio <-> owned Unix socket proxy. Deliberately no host, database, Harness or flock.
import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { checkSocket } from './unix-link.ts';

export interface BridgeIo {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** Process signal emitter; defaults to process. */
  readonly signals?: NodeJS.EventEmitter;
  readonly signal?: AbortSignal;
  /** Bounds connection and final output drain; defaults to ten seconds. */
  readonly timeoutMs?: number;
}

const readableError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1024);

/** Proxies raw bytes to an existing, owned socket. Only diagnostics go to stderr; returns a CLI exit code. */
export async function bridge(socketPath: string, io: BridgeIo = {}): Promise<number> {
  const input = io.stdin ?? process.stdin, output = io.stdout ?? process.stdout, errors = io.stderr ?? process.stderr;
  const signals = io.signals ?? process;
  const timeoutMs = io.timeoutMs ?? 10_000;
  const report = (error: unknown): void => {
    // A closed diagnostic pipe must not turn an ordinary connection failure into an unhandled stream error.
    const ignored = (): void => undefined;
    errors.once('error', ignored);
    try { errors.write(`pi-durable bridge: ${readableError(error)}\n`, () => { setImmediate(() => errors.off('error', ignored)); }); }
    catch { errors.off('error', ignored); }
  };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    report('Invalid bridge timeout'); return 1;
  }
  try { await checkSocket(socketPath); }
  catch (error) { report(error); return 1; }
  if (io.signal?.aborted) return 130;
  return new Promise<number>(resolve => {
    const socket = createConnection({ path: socketPath });
    let finished = false, timer: NodeJS.Timeout | undefined;
    const finish = (code: number, error?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.unpipe(socket);
      socket.unpipe(output);
      input.pause();
      socket.destroy();
      input.off('error', failed);
      input.off('end', inputEnded);
      input.off('close', inputClosed);
      output.off('error', failed);
      output.off('close', outputClosed);
      signals.off('SIGINT', interrupted);
      signals.off('SIGTERM', terminated);
      signals.off('SIGHUP', hungup);
      io.signal?.removeEventListener('abort', interrupted);
      if (error !== undefined) report(error);
      resolve(code);
    };
    const failed = (error: Error): void => finish(1, error);
    const deadline = (message: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(1, message), timeoutMs);
    };
    const interrupted = (): void => finish(130);
    const terminated = (): void => finish(143);
    const hungup = (): void => finish(129);
    const inputEnded = (): void => deadline('socket did not close after stdin ended');
    const inputClosed = (): void => { if (!input.readableEnded) finish(1, 'stdin closed'); };
    const outputClosed = (): void => finish(1, 'stdout closed');
    signals.on('SIGINT', interrupted);
    signals.on('SIGTERM', terminated);
    signals.on('SIGHUP', hungup);
    io.signal?.addEventListener('abort', interrupted, { once: true });
    input.on('error', failed);
    input.on('end', inputEnded);
    input.on('close', inputClosed);
    output.on('error', failed);
    output.on('close', outputClosed);
    socket.on('error', failed);
    socket.on('end', () => {
      deadline('stdout did not drain');
      // Do not close process.stdout. This callback follows every byte the socket already piped to it.
      output.write('', error => { if (error) failed(error); else finish(0); });
    });
    socket.on('close', () => { if (!socket.readableEnded) finish(1, 'socket closed'); });
    deadline('socket connection timed out');
    socket.once('connect', () => {
      if (finished) return;
      clearTimeout(timer);
      // pipe pauses each source at the destination high-water mark, bounding both directions without a queue.
      socket.pipe(output, { end: false });
      input.pipe(socket);
      if (input.readableEnded) { socket.end(); inputEnded(); }
    });
  });
}
