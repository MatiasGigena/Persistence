// `pi-durable serve` (ADR 0016): the host without a terminal. It opens the chat with coding tools on (unless
// --no-tools) and held to the protected folders (ADR 0025), listens on
// the Unix socket (and, when configured, the web listener), serves one UiSession to every client through the hub,
// and keeps the Harness, the compactor and the agents' deliveries running until a signal stops it.
import { randomBytes } from 'node:crypto';
import type { Models } from '@earendil-works/pi-ai';
import type { Config } from '../config/options.ts';
import { VERSION } from '../config/options.ts';
import { statePaths } from '../config/paths.ts';
import { errorMessage } from '../protocol/util.ts';
import { CloseCode } from '../protocol/messages.ts';
import { resumeInstance } from '../runtime/recovery.ts';
import { protection, sandboxProblem } from '../runtime/guard.ts';
import { launchOptions, openInstance, reportText } from '../runtime/runtime.ts';
import { redirectConsole } from '../runtime/console.ts';
import type { Instance } from '../runtime/runtime.ts';
import { createUiSession } from '../session/session.ts';
import type { UiSessionHandle } from '../session/session.ts';
import { Devices } from './auth.ts';
import { backup } from './backup.ts';
import { Hub } from './hub.ts';
import { MachineBroker } from './machines.ts';
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
  let unix: UnixListener | undefined, web: WebListener | undefined, session: UiSessionHandle | undefined, hub: Hub | undefined;
  const machines = new MachineBroker({ authorized: () => session?.status().toolsEnabled ?? false,
    notice: text => { log(text); session?.notify(text, 'info'); } });
  // Preserve the host's protected-tools policy; each remote connector separately starts without local permission.
  const instance = await openInstance({ ...launchOptions(config, models), configureAgent: true, onWarning: log, dispatcher: machines,
    onReport: report => log(`Pi Durable: ${reportText(report)}`) });
  let restoreConsole = (): void => undefined;
  try {
    if (signal.aborted) return;
    // Open the chat first: web initialization can create files (notably VAPID keys), and must not outlive
    // a failed/aborted instance open. These loaders own no persistent handles and settle before cleanup.
    const webWanted = settings.origin !== undefined && settings.allowLogins.length > 0;
    const loading = Promise.allSettled([Devices.open(paths.devices),
      webWanted ? createPush(paths, settings, { log: line => log(`push: ${line}`) }) : undefined, assetsHash()]);
    const [opened, pushed, hashed] = await loading;
    if (signal.aborted) return;
    const devices: Devices | undefined = opened.status === 'fulfilled' ? opened.value : undefined;
    if (opened.status === 'rejected') log(`web devices unavailable: ${errorMessage(opened.reason)}`);
    const push: PushService | undefined = pushed.status === 'fulfilled' ? pushed.value : undefined;
    if (pushed.status === 'rejected') log(`push notifications off: ${errorMessage(pushed.reason)}`);
    // Until the listener is up (or for good, with the reason the log gives), a pairing code could not be used.
    let webOff: string | undefined = 'it is still starting';
    const assets = hashed.status === 'fulfilled' ? hashed.value : 'none';
    if (hashed.status === 'rejected') log(`web app files unreadable: ${errorMessage(hashed.reason)}`);
    hub = new Hub({
      server: VERSION, boot: randomBytes(9).toString('base64url'), assets, cwd: config.cwd,
      tools: { remote: settings.remoteTools, ...settings.toolsIdleMinutes === undefined ? {} : { idleMinutes: settings.toolsIdleMinutes } },
      pushPreview: settings.pushPreview,
      ...push ? { push, revoked: (name: string) => push.forgetDevice(name) } : {},
      ...devices ? { devices } : {},
      backup: out => backup(config, instance.exclusive, out === undefined ? {} : { out }),
      ...settings.origin === undefined ? {} : { origin: settings.origin },
      webOff: () => webOff, machines, log,
    });
    unix = await listenUnix(config.socketPath, hub);
    log(`listening on ${unix.path}`);
    if (!webWanted) webOff = 'set PI_DURABLE_ORIGIN and PI_DURABLE_ALLOW_LOGIN to serve it (socket only)';
    else if (!devices) webOff = 'serve/devices.json is unreadable';
    else {
      try {
        web = await startWebListener(hub, settings, devices, { log });
        webOff = undefined;
        log(`web app on 127.0.0.1:${web.port} for ${settings.origin ?? ''}`);
      } catch (error) { webOff = errorMessage(error); }
    }
    if (webOff !== undefined) log(`web app off: ${webOff}`);
    if (signal.aborted) return;
    session = await createUiSession(instance, { model: config.model, thinkingLevel: config.thinkingLevel, allowTools: config.allowTools,
      settingsPath: config.settingsPath, authFile: config.authFile });
    // Host warnings (memory, runtime) go to the journal and, as notices, to every client.
    const notify = session.notify.bind(session);
    restoreConsole = redirectConsole(text => notify(text, 'warn'), { echo: true });
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
    restoreConsole();
    await hub?.close(CloseCode.restart, 'The server is stopping.');
    machines.close();
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
    await resumeInstance(instance, { onResume: tasks => log(`resuming ${tasks} pending task(s)`) });
  } catch (error) {
    if (!signal.aborted) log(`resuming pending work failed: ${errorMessage(error)}`);
  }
}
