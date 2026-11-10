import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@earendil-works/chord/context';
import { ConversationBusy, defineDoc, defineDocFamily, GenerationTask, hook, LiveDoc, ROOT_CONVERSATION_ID, section } from '@earendil-works/pi-durable';
import type {
  ConversationId, Extension, Harness, JsonObject, Submission, ToolExecutionResult, ToolRegistration, Tx,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { userInput } from './input.ts';
import type { SendOptions } from '../protocol/session.ts';
import type { MachineTarget } from '../protocol/machines.ts';

/** The dispatcher must wait for this destination to reconnect, never execute on another machine. */
export interface RoutingDispatcher {
  execute(target: MachineTarget, executionId: string, name: string, args: JsonObject, context: Context): Promise<ToolExecutionResult>;
}

/** A MachineTarget as the route documents store it (writable, so a draft can assign it). */
type Target = { -readonly [K in keyof MachineTarget]: MachineTarget[K] };
type RouteState = { target?: Target };

/** Constant-size server namespace; historical routes never accumulate in this shared document. */
export const RoutingDoc = defineDoc<{ namespace: string }>({
  kind: 'machines.routing', version: 1, scope: 'session', checkpointWhen: () => false,
  initial: () => ({ namespace: randomUUID() }),
});

/** Immutable request bindings, independently addressable without loading the chat's submission history. */
export const SubmissionRouteDoc = defineDocFamily<RouteState, null>({
  kind: 'machines.submission-route', version: 1, family: true,
  scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: () => false, initial: () => ({}),
});

/** The root generation task identified by LiveDoc.run.taskId owns its immutable route. */
export const RunRouteDoc = defineDoc<RouteState>({
  kind: 'machines.run-route', version: 1, scope: 'task', checkpointWhen: () => false, initial: () => ({}),
});

/** Separate from AgentDoc: syncAgents replaces configuration, but must never replace a machine pin. */
export const AgentRouteDoc = defineDoc<RouteState>({
  kind: 'machines.agent-route', version: 1,
  scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: () => false, initial: () => ({}),
});

const detached = ({ machineId, cwd, label }: MachineTarget): Target => ({ machineId, cwd, label });
const requestKey = (id: string) => `request:${id}`;
function sameTarget(first: MachineTarget, second: MachineTarget): boolean {
  return first.machineId === second.machineId && first.cwd === second.cwd && first.label === second.label;
}
function requireSame(first: MachineTarget, second: MachineTarget): void {
  if (!sameTarget(first, second)) throw new Error('Machine destination mismatch: the persisted target is immutable.');
}

export interface MachineRouting {
  readonly tools: Extension;
  initialize(context: Context): Promise<void>;
  submit(text: string, options: SendOptions, context: Context): Promise<Submission>;
  /**
   * Preserve local tool implementations and protections, but explicitly refuse unsupported remote network kits. With
   * `allowed` (a tool that comes and goes with the coding tools), permission is checked again once the destination
   * resolves, as the routed coding tools do, so `/tools off` stops an invocation already resolving.
   */
  localOnly(extension: Extension, allowed?: () => boolean): Extension;
  /** The conversation's current pinned destination; rejects when it has none (execution is blocked). */
  destination(conversationId: ConversationId, context: Context): Promise<MachineTarget>;
  /** Called inside the spawning tool's once-only transaction, immediately after creating the child. */
  pinSpawn(tx: Tx, parent: ConversationId, child: ConversationId): Promise<void>;
  /** Persist a new root delivery's exact source-session route in the transaction that creates its task. */
  pinDelivery(tx: Tx, source: ConversationId, destination: ConversationId, requestId: string): Promise<void>;
  /** The pinned destination of the root's current run, read in the commit of `tx`; undefined when it has none. */
  runTarget(tx: Tx): Promise<MachineTarget | undefined>;
  /**
   * Bind root request `requestId` to `target` (the server itself without one) before it is submitted: write-once, as
   * `submit` binds a user's message. For inputs the host itself schedules (src/schedule).
   */
  pinRequest(tx: Tx, requestId: string, target?: MachineTarget): Promise<void>;
}

/** Routing is launch-local policy around the original tools, not a replay-safety upgrade. */
export function createMachineRouting({ dispatcher, cwd, harness: opened, allowTools }: {
  dispatcher: RoutingDispatcher;
  cwd: string;
  harness: () => Harness | undefined;
  allowTools: () => boolean;
}): MachineRouting {
  const host: Target = { machineId: 'server', cwd, label: 'server' };
  const harness = (): Harness => {
    const value = opened();
    if (!value) throw new Error('Harness is not open');
    return value;
  };

  // Read submission IDs through the public submission handles: they are not request IDs.
  // Revalidate all inputs even for a pinned run, so mixed destinations cannot silently steer it.
  const resolve = async (conversationId: ConversationId, context: Context): Promise<Target> => {
    const source = harness();
    if (conversationId !== ROOT_CONVERSATION_ID) {
      const target = (await source.snapshot(AgentRouteDoc, conversationId, context))?.target;
      if (!target) throw new Error('Agent session has no pinned machine destination; execution is blocked. Delegate a new task from an explicitly targeted user turn.');
      return detached(target);
    }
    const run = (await source.snapshot(LiveDoc, conversationId, context))?.run;
    if (!run) throw new Error('Root has no active routed run; execution is blocked.');
    // Every input's route is read at once; they are checked in order below.
    const routes = await Promise.all(run.inputs.map(async (id) => {
      const submission = await source.submission(id, context);
      const requestId = (await submission?.status(context))?.requestId;
      return requestId === undefined ? undefined
        : await source.snapshot(SubmissionRouteDoc, conversationId, requestKey(requestId), context);
    }));
    let chosen: Target | undefined;
    for (const route of routes) {
      // New reports are explicitly bound when scheduled. Never infer an unmapped legacy report's
      // destination from its sender's current session, a neighboring host input, or the previous run.
      if (!route?.target) throw new Error('Root inputs have no pinned machine destination; execution is blocked.');
      if (chosen) requireSame(chosen, route.target);
      chosen = detached(route.target);
    }
    if (!chosen) throw new Error('Root inputs have no pinned machine destination; execution is blocked.');
    const pinned = chosen;
    return source.commit(async tx => {
      const live = await tx.doc(LiveDoc, conversationId);
      if (live.run?.taskId !== run.taskId || !isDeepStrictEqual([...live.run.inputs], [...run.inputs])) {
        throw new Error('Root run changed while resolving its machine destination.');
      }
      // Request bindings are write-once, so reads above stay valid once the live input list is checked.
      const route = await tx.doc(RunRouteDoc, run.taskId);
      if (route.target) requireSame(route.target, pinned);
      else route.target = pinned;
      return detached(pinned);
    }, context);
  };

  /** Refuses while `allowed()` (the launch's coding tools, by default) is false: permission is launch state. */
  const requireTools = (allowed: () => boolean = allowTools): void => {
    if (!allowed()) throw new Error('Coding tools are off for this launch.');
  };
  /** Whether `target` is the server itself; a server target must be this host's exact one. */
  const isHost = (target: MachineTarget): boolean => {
    if (target.machineId !== 'server') return false;
    requireSame(host, target);
    return true;
  };

  const nativeTools: readonly ToolRegistration[] = CodingTools.tools ?? [];
  const tools: Extension = {
    ...CodingTools,
    tools: nativeTools.map(tool => ({
      ...tool,
      // Keep native replay policy. A restart after dispatch may settle as interrupted/unknown;
      // making unsafe local bash/write/edit replay-safe would permit duplicate host effects.
      async execute(args: JsonObject, api, context) {
        requireTools();
        const [target, routing] = await Promise.all([resolve(api.conversationId, context), api.snapshot(RoutingDoc, context)]);
        const namespace = routing?.namespace;
        if (!namespace) throw new Error('Machine execution namespace is missing.');
        const candidate = { target, executionId: `${namespace}:${api.taskId}`, name: tool.name, args };
        // Immutable intent is committed before any dispatch, including when hooks were skipped on replay.
        const intent = await api.memo('machines.intent', candidate, context);
        if (!isDeepStrictEqual(intent, candidate)) throw new Error('Machine tool intent mismatch.');
        // Permission is launch state, never a persisted authorization in an intent or agent document.
        requireTools();
        if (isHost(intent.target)) return tool.execute(args, api, context);
        return dispatcher.execute(detached(intent.target), intent.executionId, intent.name, intent.args, context);
      },
    })),
    hooks: [...(CodingTools.hooks ?? []), hook(GenerationTask, {
      beforeRequest: async (_request, api, context) => {
        const target = await resolve(api.conversationId, context);
        const stored = await api.memo('machines.target', target, context);
        requireSame(stored, target);
        return undefined;
      },
    })],
    sections: [...(CodingTools.sections ?? []), section('machine', async (input, context) => {
      try {
        const target = await resolve(input.conversationId, context);
        return `Execution destination: ${JSON.stringify(target.label)} (machine ${JSON.stringify(target.machineId)}).\n`
          + `Working directory: ${JSON.stringify(target.cwd)}.\n`
          + 'Coding tools, delegated task sessions and newly spawned agents stay on this immutable destination. An offline machine is not replaced by the server. Browser and web_fetch tools are unsupported on remote destinations and will refuse rather than run on the server.';
      } catch {
        // SDK hooks/sections report ordinary exceptions but do not stop requests. Tools independently fail closed.
        return 'This run has no valid machine destination. Coding tool execution and spawning agents are blocked; do not assume the server or a previous destination.';
      }
    })],
  };

  /** The root's current run's pin, as its first request stored it. */
  const runTarget = async (tx: Tx): Promise<Target | undefined> => {
    const run = (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).run;
    return run ? (await tx.doc(RunRouteDoc, run.taskId)).target : undefined;
  };

  return {
    tools,
    initialize: context => harness().commit(async tx => { await tx.doc(RoutingDoc); }, context),
    destination: resolve,
    localOnly: (extension, allowed) => ({
      ...extension,
      tools: extension.tools?.map(tool => ({
        ...tool,
        async execute(args: JsonObject, api, context) {
          if (allowed) requireTools(allowed);
          const target = await resolve(api.conversationId, context);
          if (!isHost(target)) {
            throw new Error(`Tool ${tool.name} is not supported on remote machine ${JSON.stringify(target.label)}; it will not run on the server instead.`);
          }
          // Permission is launch state: /tools off may have landed while the destination resolved.
          if (allowed) requireTools(allowed);
          return tool.execute(args, api, context);
        },
      })),
    }),
    async submit(text, { requestId = randomUUID(), target = host, steer, images }, context) {
      if (!target.machineId || !target.cwd || !target.label) throw new Error('Invalid machine destination.');
      isHost(target); // throws for a server target other than this host
      const pinned = detached(target);
      // A crash here leaves an unused mapping, not an unpinned submission. Retrying may only use this target.
      await harness().commit(async tx => {
        const route = await tx.doc(SubmissionRouteDoc, ROOT_CONVERSATION_ID, requestKey(requestId), null);
        if (route.target) requireSame(route.target, pinned);
        else {
          // A retry must not retroactively assign a destination to a pre-routing or agent-owned input.
          if (await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId)) {
            throw new Error('This request already exists without a pinned machine destination; send a new request instead.');
          }
          route.target = pinned;
        }
      }, context);
      const root = await harness().root(context);
      // pi-durable (admitSubmission) checks dedup first, then throws ConversationBusy before creating a rejected input.
      // The public admission API cannot atomically compare a busy run's target and steer it. A separate
      // snapshot check would race another run's admission, so routed follow-ups and steering both reject.
      try {
        return await root.submit({ type: 'input', content: userInput(text, images), requestId, whenBusy: 'reject' }, context);
      } catch (error) {
        if (steer && error instanceof ConversationBusy) {
          throw new Error('Cannot steer a busy routed run; wait for it to finish and resend to the same machine.', { cause: error });
        }
        throw error;
      }
    },
    async pinDelivery(tx, source, destination, requestId) {
      if (destination !== ROOT_CONVERSATION_ID || source === ROOT_CONVERSATION_ID) return;
      const inherited = (await tx.doc(AgentRouteDoc, source)).target;
      // Keep legacy deliveries readable, without manufacturing execution authority for unpinned sessions.
      if (!inherited) return;
      const route = await tx.doc(SubmissionRouteDoc, destination, requestKey(requestId), null);
      if (route.target) requireSame(route.target, inherited);
      else route.target = detached(inherited);
    },
    runTarget,
    async pinRequest(tx, requestId, target = host) {
      isHost(target); // throws for a server target other than this host
      const route = await tx.doc(SubmissionRouteDoc, ROOT_CONVERSATION_ID, requestKey(requestId), null);
      if (route.target) requireSame(route.target, target);
      else route.target = detached(target);
    },
    async pinSpawn(tx, parent, child) {
      const inherited = parent === ROOT_CONVERSATION_ID ? await runTarget(tx) : (await tx.doc(AgentRouteDoc, parent)).target;
      if (!inherited) throw new Error('Spawner has no pinned machine destination; spawning or delegation is blocked. Start from an explicitly targeted user turn.');
      const route = await tx.doc(AgentRouteDoc, child);
      if (route.target) requireSame(route.target, inherited);
      else route.target = detached(inherited);
    },
  };
}
