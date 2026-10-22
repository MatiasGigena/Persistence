// Attaching the terminal UI to a running server (ADR 0018): an interactive launch probes the chat's socket, and
// when a server answers it runs the TUI here on a RemoteSession, with no flock, ModelRuntime or Harness in this
// process. Otherwise src/cli.ts takes the local path. Detaching leaves the server working.
import { format } from 'node:util';
import type { Terminal } from '@earendil-works/pi-tui';
import { VERSION } from '../host/config.ts';
import type { Config } from '../host/config.ts';
import { RemoteSession } from './remote-session.ts';
import { ClientLink, ForeignSocket, unixConnector } from './unix-link.ts';

/** `hello.client` of the attached TUI. */
export const CLIENT = `pi-durable-tui ${VERSION}`;
/** How long a probe waits for the server's welcome. */
export const PROBE_MS = 1500;
/** How long a probe waits for `ready` after the welcome. */
const READY_MS = 10_000;
/** Printed after the user detaches. */
export const DETACHED = 'Detached; the server keeps working.';
/** Printed when the flock is busy because a server holds it. */
export const SERVER_RUNS = 'A server runs this chat; run `pi-durable` to attach.';

/** Whether stdin and stdout are terminals. */
export interface Tty {
  readonly stdin: boolean;
  readonly stdout: boolean;
}

const processTty = (): Tty => ({ stdin: process.stdin.isTTY, stdout: process.stdout.isTTY });

/** An interactive full-screen launch, the only kind that attaches: no one-shot mode, no --plain, no pipe. */
export function probes(config: Config, tty: Tty = processTty()): boolean {
  return config.command === 'chat' && !config.local && !config.plain && !config.resume && !config.history
    && !config.status && config.prompt === undefined && tty.stdin && tty.stdout && config.socketPath !== undefined;
}

/**
 * A session on the server at `socketPath`, connected and ready; undefined when no server answers (no socket, a
 * stale one, or no welcome within `PROBE_MS`). Throws when the socket is not the user's.
 */
export async function connect(socketPath: string, helloMs = PROBE_MS): Promise<RemoteSession | undefined> {
  const link = new ClientLink({ connect: unixConnector(socketPath), client: CLIENT, helloMs });
  const session = new RemoteSession(link);
  try { await link.start(); } catch (error) {
    if (error instanceof ForeignSocket) throw error;
    return undefined;
  }
  // The state follows the welcome at once; a server that never gets there is not one to attach to.
  const timer = setTimeout(() => void session.close(), READY_MS);
  try { await session.ready(); } catch { return undefined; } finally { clearTimeout(timer); }
  return session;
}

/** Whether a server answers at `socketPath` now. */
export async function serverAnswers(socketPath: string | undefined): Promise<boolean> {
  if (socketPath === undefined) return false;
  const session = await connect(socketPath).catch(() => undefined);
  await session?.close();
  return session !== undefined;
}

export interface AttachIo {
  readonly tty?: Tty;
  /** Default: the process's terminal. */
  readonly terminal?: Terminal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Local execution directory for a remote connector's editor path completion. */
  readonly cwd?: string;
  readonly initialNotice?: string;
  /** Detaches when it aborts, as SIGTERM and SIGHUP do. */
  readonly signal?: AbortSignal;
  /** Where the closing line goes; default stdout. */
  readonly print?: (line: string) => void;
}

/**
 * Attaches when this launch should: `--attach` (failing without a server), or an interactive launch that finds
 * one. Resolves with the exit code once the TUI detaches, or undefined for the local path.
 */
export async function attachChat(config: Config, io: AttachIo = {}): Promise<number | undefined> {
  const tty = io.tty ?? processTty();
  if (!config.attach && !probes(config, tty)) return undefined;
  const socket = config.socketPath;
  if (socket === undefined) {
    if (!config.attach) return undefined;
    throw new Error('This chat has no server socket: its path is too long and XDG_RUNTIME_DIR is unset');
  }
  const session = await connect(socket);
  if (!session) {
    if (!config.attach) return undefined;
    throw new Error(`No server answers at ${socket}. Start one with \`pi-durable serve\`, or run without --attach.`);
  }
  if (config.launchOption !== undefined || !tty.stdin || !tty.stdout) {
    await session.close();
    throw new Error(config.launchOption !== undefined
      ? `${config.launchOption} does not apply: a server runs this chat, and its settings apply (use /model and /tools after attaching)`
      : 'Attaching needs a terminal (stdin and stdout)');
  }
  return runAttached(session, io);
}

/** Runs the TUI on `session` until the user detaches or the link closes for good; resolves with the exit code. */
export async function runAttached(session: RemoteSession, io: AttachIo = {}): Promise<number> {
  const { runTui } = await import('../ui/tui/app.ts');
  const shutdown = new AbortController();
  let code = 0;
  const handlers = new Map((['SIGTERM', 'SIGHUP', 'SIGINT'] as const).map(signal => [signal, () => {
    code = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    shutdown.abort();
  }]));
  const onAbort = (): void => shutdown.abort();
  io.signal?.addEventListener('abort', onAbort, { once: true });
  for (const [signal, handler] of handlers) process.on(signal, handler);
  // The TUI owns the screen: stray console output becomes a notice in the chat, as in the host.
  const { error, warn } = console;
  try {
    await runTui(session, {
      cwd: io.cwd ?? session.welcome()?.cwd ?? process.cwd(), signal: shutdown.signal, attached: session.attached,
      ...io.terminal ? { terminal: io.terminal } : {}, ...io.env ? { env: io.env } : {},
      onStart: () => {
        console.error = console.warn = (...args: unknown[]) => session.notify(format(...args), 'warn');
        if (io.initialNotice) session.notify(io.initialNotice);
      },
    });
  } finally {
    console.error = error;
    console.warn = warn;
    for (const [signal, handler] of handlers) process.off(signal, handler);
    io.signal?.removeEventListener('abort', onAbort);
  }
  // A link closed by the server has left its notice in the scrollback already.
  const lost = session.attached.state() === 'closed';
  await session.close();
  if (lost) return 1;
  (io.print ?? console.log)(DETACHED);
  return code;
}
