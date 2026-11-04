import type { Context } from '@earendil-works/chord';
import type { JsonObject, ToolExecutionResult } from '@earendil-works/pi-durable';
import { MACHINE_TOOLS, jsonData } from '../protocol/machines.ts';
import type { MachineCall, MachineCancel, MachineRegistration, MachineResult } from '../protocol/machines.ts';
import type { MachineTarget } from '../protocol/machines.ts';

export interface MachinePeer {
  readonly isClosed: boolean;
  sendMachine(message: MachineCall | MachineCancel): void;
}
interface Pending {
  readonly call: MachineCall;
  readonly fingerprint: string;
  readonly resolve: (result: ToolExecutionResult) => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<ToolExecutionResult>;
  readonly cleanup: () => void;
  assigned?: MachinePeer;
}
const keyOf = (target: MachineTarget): string => JSON.stringify([target.machineId, target.cwd]);

/** Executes only on the pinned, authenticated connector. Lost links never mean host fallback or a new execution id. */
export class MachineBroker {
  private readonly peers = new Map<MachinePeer, MachineRegistration>();
  private readonly pending = new Map<string, Pending>();
  private stopping = false;
  constructor(privateOptions: { authorized: () => boolean; notice?: (text: string) => void }) { this.options = privateOptions; }
  private readonly options: { authorized: () => boolean; notice?: (text: string) => void };

  register(peer: MachinePeer, registration: MachineRegistration): void {
    if (this.stopping || peer.isClosed) throw new Error('The machine connection is closed');
    const key = keyOf(registration.target), before = this.peers.get(peer);
    if (registration.target.machineId === 'server') throw new Error('The machine id server is reserved');
    if (before && keyOf(before.target) !== key) throw new Error('A connection cannot change its execution machine or directory');
    for (const [other, machine] of this.peers) {
      if (other !== peer && !other.isClosed && keyOf(machine.target) === key) throw new Error('This machine and directory already have an active connector');
    }
    this.peers.set(peer, registration);
    for (const pending of this.pending.values()) this.dispatch(pending);
  }

  /** Turns a registered connector's tools on or off; returns its registration as it now is. */
  setEnabled(peer: MachinePeer, enabled: boolean): MachineRegistration {
    const before = this.peers.get(peer);
    if (!before) throw new Error('Register an execution machine first');
    const registration = { ...before, enabled };
    this.peers.set(peer, registration);
    for (const pending of this.pending.values()) {
      if (!enabled && pending.assigned === peer) peer.sendMachine({ t: 'machine.cancel', id: pending.call.id });
      else this.dispatch(pending);
    }
    return registration;
  }
  list(): readonly MachineRegistration[] { return [...this.peers.values()]; }

  disconnected(peer: MachinePeer): void {
    this.peers.delete(peer);
    for (const pending of this.pending.values()) if (pending.assigned === peer) {
      pending.assigned = undefined;
      this.options.notice?.(`Waiting for ${pending.call.target.label} (${pending.call.target.cwd}); execution stays pinned to that machine.`);
    }
  }

  result(peer: MachinePeer, message: MachineResult): void {
    const pending = this.pending.get(message.id);
    if (!pending || pending.assigned !== peer || !this.peers.has(peer)) return;
    this.finish(pending);
    pending.resolve(message.result);
  }

  execute(target: MachineTarget, executionId: string, toolName: string, args: JsonObject, context: Context): Promise<ToolExecutionResult> {
    if (this.stopping || !this.options.authorized()) return Promise.reject(new Error('Coding tools are off for this server launch'));
    if (context.abortSignal?.aborted) return Promise.reject(new Error('Remote execution cancelled'));
    const name = MACHINE_TOOLS.find(each => each === toolName);
    if (!name || target.machineId === 'server') return Promise.reject(new Error('Invalid remote execution destination or tool'));
    const parsed = jsonData(args);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return Promise.reject(new Error('Invalid tool arguments'));
    const call: MachineCall = { t: 'machine.call', id: executionId, target, name, args: parsed };
    const fingerprint = JSON.stringify(call);
    const before = this.pending.get(executionId);
    if (before) return before.fingerprint === fingerprint ? before.promise : Promise.reject(new Error('Execution id reused with another payload'));
    const deferred = Promise.withResolvers<ToolExecutionResult>();
    const signal = context.abortSignal;
    const cancel = (): void => {
      const pending = this.pending.get(executionId);
      if (!pending) return;
      pending.assigned?.sendMachine({ t: 'machine.cancel', id: executionId });
      this.finish(pending);
      deferred.reject(new Error(`Remote execution cancelled on ${target.label}; check partial side effects before retrying`));
    };
    const pending: Pending = { call, fingerprint, ...deferred, cleanup: () => signal?.removeEventListener('abort', cancel) };
    signal?.addEventListener('abort', cancel, { once: true });
    this.pending.set(executionId, pending);
    this.options.notice?.(`Tools on ${target.label}: ${target.cwd} (${name}).`);
    this.dispatch(pending);
    if (!pending.assigned) this.options.notice?.(`Waiting for the authorized connector of ${target.label} (${target.cwd}). No other machine will run this call.`);
    return deferred.promise;
  }

  close(): void {
    this.stopping = true;
    for (const pending of [...this.pending.values()]) {
      pending.assigned?.sendMachine({ t: 'machine.cancel', id: pending.call.id });
      this.finish(pending);
      pending.reject(new Error('The server closed; the remote execution may have partially run. Check its result before retrying.'));
    }
    this.peers.clear();
  }

  private dispatch(pending: Pending): void {
    if (pending.assigned || this.stopping) return;
    if (!this.options.authorized()) {
      this.finish(pending);
      pending.reject(new Error('Coding tools are off; reconnecting cannot restore permission'));
      return;
    }
    for (const [peer, machine] of this.peers) {
      if (!peer.isClosed && machine.enabled && keyOf(machine.target) === keyOf(pending.call.target)) {
        pending.assigned = peer;
        peer.sendMachine(pending.call);
        return;
      }
    }
  }
  private finish(pending: Pending): void {
    this.pending.delete(pending.call.id);
    pending.cleanup();
  }
}
