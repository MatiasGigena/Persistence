// An execution machine's connection to the central server: a RemoteSession whose link registers this machine on every
// `ready` and runs the server's machine calls with the local executor. The SSH TUI (remote.ts) and the end-to-end
// tests both build it here, so the tests run the wiring users run.
import { ENABLE_TOOLS } from '../protocol/messages.ts';
import type { MachineCall, MachineTarget, MachineToolResult } from '../protocol/machines.ts';
import { errorMessage } from '../protocol/util.ts';
import { RemoteSession } from './remote-session.ts';
import type { ServerLink } from './remote-session.ts';

/** What the connection needs of the executor (src/client/machine-executor.ts). */
export interface MachineRunner {
  execute(call: MachineCall): Promise<MachineToolResult>;
  cancel(id: string): void;
  setEnabled(enabled: boolean): void;
}

export interface MachineConnectionOptions {
  /** This process's grant at start (`--allow-tools`, never restored from disk); `/tools` changes it later. */
  readonly enabled: boolean;
  readonly clientId?: string;
  /** Hands a call's result to `send`, which gives it to the server; the default sends at once. Tests observe here. */
  readonly deliver?: (call: MachineCall, result: MachineToolResult, send: () => void) => void | Promise<void>;
}

export interface MachineConnection {
  readonly session: RemoteSession;
  /** The registration after the latest `ready`; a refused one has notified and closed the link. */
  registered(): Promise<unknown>;
  /** Stops handling the link's machine messages. */
  dispose(): void;
}

/**
 * Builds the session for `target` over `link` and wires the machine messages: register (with the current grant) on
 * each `ready`, run each `machine.call` with `runner` (a thrown error becomes an error result), honour cancels, and
 * keep the runner's grant in step with `/tools`.
 */
export function connectMachine(link: ServerLink, target: MachineTarget, runner: MachineRunner, options: MachineConnectionOptions): MachineConnection {
  let enabled = options.enabled;
  const deliver = options.deliver ?? ((_call, _result, send) => send());
  const session = new RemoteSession(link, {
    ...options.clientId === undefined ? {} : { clientId: options.clientId },
    target, requireMachines: true, machineToolsEnabled: () => enabled,
    setMachineTools: async next => {
      enabled = next;
      runner.setEnabled(next);
      await session.request('machine.set', next ? { enabled: true, confirm: ENABLE_TOOLS } : { enabled: false });
    },
  });
  let registered: Promise<unknown> = Promise.resolve();
  const dispose = link.onMessage(message => {
    if (message.t === 'ready') {
      registered = session.request('machine.register', { registration: { target, enabled } });
      registered.catch((error: unknown) => {
        session.notify(errorMessage(error), 'error');
        link.close();
      });
    } else if (message.t === 'machine.call') {
      void runner.execute(message)
        .catch((error: unknown): MachineToolResult => ({ isError: true, output: [{ type: 'text', text: errorMessage(error) }] }))
        .then(result => deliver(message, result, () => { link.send({ t: 'machine.result', id: message.id, result }); }));
    } else if (message.t === 'machine.cancel') runner.cancel(message.id);
  });
  return { session, registered: () => registered, dispose };
}
