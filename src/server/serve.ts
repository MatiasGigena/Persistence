// `pi-durable serve` (ADR 0016): the host without a terminal. It opens the chat with coding tools on (unless
// --no-tools) and held to the protected folders (ADR 0025), listens on
// the Unix socket (and, when configured, the web listener), serves one UiSession to every client through the hub,
// and keeps the Harness, the compactor and the agents' deliveries running until a signal stops it.
import { randomBytes } from 'node:crypto';
import { format } from 'node:util';
import type { Models } from '@earendil-works/pi-ai';
import type { Config } from '../host/config.ts';
import { errorMessage, isRecord, statePaths, VERSION } from '../host/config.ts';
import { CloseCode } from '../protocol/messages.ts';
import { resumeInstance } from '../runtime/recovery.ts';
import { protection, sandboxProblem } from '../runtime/guard.ts';
import { openInstance } from '../runtime/runtime.ts';
import type { Instance } from '../runtime/runtime.ts';
import { createUiSession } from '../ui/session.ts';
import type { UiSessionHandle } from '../ui/session.ts';
import { Devices } from './auth.ts';
import { backup } from './backup.ts';
import { Hub } from './hub.ts';
import { createPush } from './push.ts';
import type { PushService } from './push.ts';
import { assetsHash } from './static.ts';
import { startWebListener } from './transport-ws.ts';
import type { WebListener } from './transport-ws.ts';
import { listenUnix } from './transport-unix.ts';
import type { UnixListener } from './transport-unix.ts';

/** What `serve` needs besides the config: the model catalog, and the signal that stops it. */
export interface ServeOptions {
  readonly models: Models;
  readonly signal: AbortSignal;
  /** One line for the server's log (the systemd journal). Default: stderr. */
  readonly log?: (line: string) => void;
}

const field = (value: unknown, key: string): unknown => isRecord(value) ? value[key] : undefined;
const stderr = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * Runs the server until `signal` aborts, then sends every peer `bye` 1012, closes the listeners, the session and the
 * Instance (durably: unfinished work resumes at the next start). Rejects when the chat cannot be opened or the socket
 * cannot be listened on.
 */
export async function serve(config: Config, { models, signal, log = stderr }: ServeOptions): Promise<void> {
  const settings = config.serve;
  if (!settings) throw new Error('serve needs its settings');
  if (!config.socketPath) throw new Error(`The socket path for ${config.databasePath} is over 107 bytes and XDG_RUNTIME_DIR is unset; use a shorter --database path`);
  const paths = statePaths(config.databasePath);
  // Coding tools are on unless --no-tools (ADR 0025), held to the protected folders like a local launch's.
  const instance = await openInstance({ ...config, models, protection: protection(config), onWarning: log,
    onReport: report => log(`Pi Durable: ${String(field(field(report, 'error'), 'message') ?? field(report, 'message') ?? field(report, 'kind') ?? 'runtime report')}`) });
  let unix: UnixListener | undefined, web: WebListener | undefined, session: UiSessionHandle | undefined, hub: Hub | undefined;
  const { error: consoleError, warn: consoleWarn } = console;
  try {
    if (signal.aborted) return;
    const webWanted = settings.origin !== undefined && settings.allowLogins.length > 0;
    let devices: Devices | undefined;
    try { devices = await Devices.open(paths.devices); } catch (error) { log(`web devices unavailable: ${errorMessage(error)}`); }
    let push: PushService | undefined;
    if (webWanted) {
      try { push = await createPush(paths, settings, { log: line => log(`push: ${line}`) }); } catch (error) {
        log(`push notifications off: ${errorMessage(error)}`);
      }
    }
    let assets = 'none';
    try { assets = await assetsHash(); } catch (error) { log(`web app files unreadable: ${errorMessage(error)}`); }
    hub = new Hub({
      server: VERSION, boot: randomBytes(9).toString('base64url'), assets, cwd: config.cwd,
      tools: { remote: settings.remoteTools, ...settings.toolsIdleMinutes === undefined ? {} : { idleMinutes: settings.toolsIdleMinutes } },
      pushPreview: settings.pushPreview,
      ...push ? { push, revoked: (name: string) => push.forgetDevice(name) } : {},
      ...devices ? { devices } : {},
      backup: out => backup(config, instance.exclusive, out === undefined ? {} : { out }),
      log,
    });
    unix = await listenUnix(config.socketPath, hub);
    log(`listening on ${unix.path}`);
    if (!webWanted) log('web app off: set PI_DURABLE_ORIGIN and PI_DURABLE_ALLOW_LOGIN to serve it (socket only)');
    else if (!devices) log('web app off: serve/devices.json is unreadable');
    else {
      try {
        web = await startWebListener(hub, settings, devices, { log });
        log(`web app on 127.0.0.1:${web.port} for ${settings.origin ?? ''}`);
      } catch (error) { log(`web app off: ${errorMessage(error)}`); }
    }
    if (signal.aborted) return;
    session = await createUiSession(instance, { model: config.model, thinkingLevel: config.thinkingLevel, allowTools: config.allowTools,
      settingsPath: config.settingsPath, authFile: config.authFile });
    // Host warnings (memory, runtime) go to the journal and, as notices, to every client.
    const notify = session.notify.bind(session);
    console.error = (...args: unknown[]) => { consoleError(...args); notify(format(...args), 'warn'); };
    console.warn = (...args: unknown[]) => { consoleWarn(...args); notify(format(...args), 'warn'); };
    hub.start(session);
    log(`ready: ${config.databasePath}, tools ${config.allowTools ? 'on (protected folders enforced)' : 'off'}, cwd ${config.cwd}`);
    // Said now, to the journal and every client, rather than at Pi's first bash call.
    void sandboxProblem(protection(config)).then(problem => { if (problem) console.warn(`Coding tools: bash is off. ${problem}`); });
    // Pending work resumes behind the session, so clients watch it rather than wait for it.
    void resume(instance, log, signal);
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    log('stopping');
    await hub.close(CloseCode.restart, 'The server is stopping.');
    await Promise.all([unix.close(), web?.close()]);
    unix = web = undefined;
  } finally {
    console.error = consoleError;
    console.warn = consoleWarn;
    await hub?.close(CloseCode.restart, 'The server is stopping.');
    await Promise.allSettled([unix?.close(), web?.close()]);
    try { await session?.close(); } finally { await instance.close(); }
  }
}

/**
 * Resumes interrupted work, as an interactive launch does before it starts; failures go to the log. Not awaited at
 * shutdown: the Instance's close interrupts the work durably, and the next start resumes it.
 */
async function resume(instance: Instance, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  try {
    const inspection = await instance.harness.inspect(instance.context);
    if (!inspection.tasks.length && !inspection.submissions.length) return;
    log(`resuming ${inspection.tasks.length} pending task(s)`);
    await resumeInstance(instance);
  } catch (error) {
    if (!signal.aborted) log(`resuming pending work failed: ${errorMessage(error)}`);
  }
}
