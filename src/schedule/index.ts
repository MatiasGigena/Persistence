import type { Context } from '@earendil-works/chord/context';
import { defineDoc, defineTask, defineTool, ROOT_CONVERSATION_ID, section } from '@earendil-works/pi-durable';
import type {
  DocumentReader, Extension, NextTaskState, Session, TaskId, TaskOptions, ToolExecutionApi, ToolExecutionResult, ToolRegistration, Tx,
} from '@earendil-works/pi-durable';
import { int, num, obj, opt, str } from '@earendil-works/pi-schema';
import { formatDate } from '../memory/util.ts';
import type { MachineTarget } from '../protocol/machines.ts';
import { NotFound } from '../protocol/errors.ts';
import { CronError, nextAfter, parseCron, shortestGap } from './cron.ts';
import { FIRE_KIND, fireName } from './entries.ts';

export { FIRE_KIND, fireName, scheduleFireOf } from './entries.ts';
export type { ScheduleFire } from './entries.ts';

/**
 * Scheduled wake-ups (ADR 0038): Pi leaves itself a message for later, once or on a cron expression.
 *
 * Each schedule is a `schedule.wake` task of Pi's conversation, in the background, so Pi's Esc and idle waits never
 * reach it. The task sleeps durably until the schedule is due (pi-durable's `sleepUntil`), then submits the message to
 * Pi as a follow-up input with the request ID `schedule:<task id>:<occurrence>`, and in the next commit sleeps again
 * (a repeating schedule) or ends. A crash between the two reruns the phase, and the request ID returns the first
 * submission, so a wake-up arrives exactly once. A host that was closed when a schedule came due delivers it at its
 * next work launch, late, and a repeating one skips the occurrences it missed.
 *
 * The registry document lists the schedules; a schedule no longer in it is cancelled, and its task ends without
 * submitting when it next wakes. Only Pi has the tools: the host removes the extension from every agent.
 */

/** Persisted names (ADR 0038): never rename. */
export const SCHEDULE_EXTENSION = 'schedule';
export const WAKE_KIND = 'schedule.wake';
/** The most schedules at once: each fire is a model run, so the list stays one the user can oversee. */
export const MAX_SCHEDULES = 32;
/** The longest message a schedule carries, in characters. */
export const MAX_TEXT = 4_000;
/** A repeating schedule fires at most this often. */
export const MIN_EVERY_MS = 300_000;
/** A one-off schedule is at most this far ahead. */
export const MAX_AHEAD_MS = 2 * 366 * 86_400_000;
/** A wake-up delivered this long after it was due says so: the host was not running. */
export const LATE_MS = 120_000;
/** A wake-up that cannot be submitted is tried again this often, this many times, then dropped with a report. */
const RETRY_MS = 60_000;
const DELIVERY_TRIES = 5;
const KEEP_CALLS = 64;

/** One schedule: its task, its message, when it next fires, and how often it has. */
export type ScheduleItem = {
  taskId: TaskId; text: string; at: number; createdAt: number; fired: number;
  /** A repeating schedule's expression; absent on a one-off. */
  cron?: string;
};
/** `next` numbers the schedules from 1; `calls` maps a tool task ID to the result its first run returned. */
export type ScheduleState = { next: number; items: Record<string, ScheduleItem>; calls: Record<string, string> };

/** Session-wide registry of the schedules. */
export const ScheduleDoc = defineDoc<ScheduleState>({
  kind: 'schedule.registry',
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, items: {}, calls: {} }),
  // Every fire and every tool call writes a delta: a base now and then keeps a reopen short.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** One schedule, as the host lists it. */
export interface ScheduleInfo {
  readonly id: number;
  readonly text: string;
  /** When it next fires, ms since the epoch. */
  readonly at: number;
  readonly cron?: string;
}

/**
 * Where a wake-up's run executes its tools, with machine routing (ADR 0028). Without it (a local launch) schedules
 * need no destination.
 */
export interface ScheduleRouting {
  /** The destination of the root's current run, read in the commit of `tx`; undefined when it has none. */
  current(tx: Tx): Promise<MachineTarget | undefined>;
  /** Bind root request `requestId` to `target`, or to the server itself without one, in the commit of `tx`. */
  pin(tx: Tx, requestId: string, target: MachineTarget | undefined): Promise<void>;
}

/** Options of `createScheduleExtension()`. */
export interface ScheduleOptions {
  readonly routing?: ScheduleRouting;
  /**
   * Aborts a cancelled schedule's sleeping task (the Harness's `abortTask`), so it does not linger until its time. A
   * tool cannot abort a task it does not own; without this, the task ends by itself when it next wakes.
   */
  readonly abortTask?: (id: TaskId, context: Context) => Promise<unknown>;
}

/** The schedule extension; its `tools` are what the host enables for Pi. */
export interface ScheduleExtension extends Extension {
  readonly tools: readonly ToolRegistration[];
}

type WakeInput = { id: number; at: number; target?: { machineId: string; cwd: string; label: string } };
/** `due`: when this occurrence was due; `n`: how many came before it; `tries`: failed deliveries of this one. */
type WakeState = { phase: 'wait' } | { phase: 'fire'; due: number; n: number; tries?: number };
type Parsed = { at: number; cron?: string } | { error: string };

const TASK_OPTIONS: TaskOptions = { ownership: { kind: 'conversation' }, background: true, conversationId: ROOT_CONVERSATION_ID };
const reply = (text: string): ToolExecutionResult => ({ output: [{ type: 'text', text }] });
const done = (): NextTaskState<WakeState, null> => ({ status: 'terminal', outcome: { status: 'completed', result: null } });
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The schedules, soonest first. */
const sorted = (items: Readonly<Record<string, ScheduleItem>>): ScheduleInfo[] => Object.entries(items)
  .map(([id, item]) => ({ id: Number(id), text: item.text, at: item.at, ...item.cron === undefined ? {} : { cron: item.cron } }))
  .sort((a, b) => a.at - b.at || a.id - b.id);

/** One schedule as `list_schedules` and the tools' results name it. */
const line = (info: ScheduleInfo): string => `#${info.id} ${info.cron === undefined ? 'once' : `cron "${info.cron}", next`} `
  + `${formatDate(info.at)}: ${info.text}`;

/**
 * When a `schedule` call fires first, from exactly one of `at`, `in_minutes` and `cron`, against the clock `now`; or
 * why not, in words the model can act on.
 */
export function firstFire({ at, in_minutes: minutes, cron }: { at?: string | undefined; in_minutes?: number | undefined; cron?: string | undefined },
  now: number): Parsed {
  const given = [at, minutes, cron].filter(each => each !== undefined).length;
  if (given !== 1) return { error: 'Give exactly one of at, in_minutes or cron.' };
  if (cron !== undefined) {
    try {
      const parsed = parseCron(cron);
      const first = nextAfter(parsed, now);
      if (first === undefined) return { error: `cron "${cron}" matches no time in the next five years.` };
      const gap = shortestGap(parsed, now);
      if (gap !== undefined && gap < MIN_EVERY_MS) {
        return { error: `cron "${cron}" fires ${Math.round(gap / 60_000)} min apart; a schedule repeats at most every ${MIN_EVERY_MS / 60_000} minutes.` };
      }
      return { at: first, cron: cron.trim().split(/\s+/).join(' ') };
    } catch (error) {
      if (error instanceof CronError) return { error: `Invalid cron "${cron}": ${error.message}.` };
      throw error;
    }
  }
  if (minutes !== undefined) {
    if (!Number.isFinite(minutes) || minutes < 1) return { error: 'in_minutes must be at least 1.' };
    if (minutes * 60_000 > MAX_AHEAD_MS) return { error: 'in_minutes is more than two years ahead.' };
    return { at: now + Math.round(minutes * 60_000) };
  }
  const text = (at ?? '').trim();
  const time = ISO.test(text) ? new Date(text.replace(' ', 'T')).getTime() : Number.NaN;
  if (Number.isNaN(time)) return { error: `at ${JSON.stringify(at)} is not a date and time such as 2026-11-12T09:00 (the host's local time) or 2026-11-12T09:00-03:00.` };
  if (time <= now) return { error: `at ${text} is in the past: now is ${formatDate(now)}.` };
  if (time - now > MAX_AHEAD_MS) return { error: `at ${text} is more than two years ahead.` };
  return { at: time };
}

/**
 * The message a wake-up reaches Pi as: who it is from, the text, and one line of context (when it was due, whether it
 * is late, how a repeating one stops). The memory logs it as a `work` message, so it starts with `[Schedule #n]`.
 */
export function fireText(id: number, item: Pick<ScheduleItem, 'text' | 'createdAt' | 'cron'>, due: number, now: number, next?: number): string {
  const late = now - due > LATE_MS ? `; delivered late, at ${formatDate(now)}: the host was not running then` : '';
  const repeats = item.cron === undefined ? '' : ` It repeats (cron "${item.cron}"${next === undefined ? '' : `, next ${formatDate(next)}`}); `
    + `cancel_schedule(${id}) stops it.`;
  return `[${fireName(id)}] ${item.text}\n\n(A wake-up you scheduled on ${formatDate(item.createdAt)}, due ${formatDate(due)}${late}.${repeats})`;
}

/** How many schedules the turn state names; the rest are counted. */
const TURN_SCHEDULES = 5;

/**
 * Pi's schedules as one line of its turn state, so it knows what is already scheduled without a tool call:
 * `schedules: #3 2026-11-12 09:00:00 -03:00 (Thursday); #4 cron "0 9 * * 1-5", next …`, the soonest five and a count of
 * the rest. Undefined when there are none: the turn state then says nothing about schedules.
 */
export function schedulesLine(schedules: readonly ScheduleInfo[]): string | undefined {
  if (!schedules.length) return undefined;
  const named = schedules.slice(0, TURN_SCHEDULES).map(each => `#${each.id} ${each.cron === undefined ? '' : `cron "${each.cron}", next `}${formatDate(each.at)}`);
  const rest = schedules.length - named.length;
  return `schedules: ${named.join('; ')}${rest ? `; and ${rest} more (list_schedules)` : ''}`;
}

/** The schedules, soonest first. */
export async function listSchedules(source: DocumentReader, context: Context): Promise<ScheduleInfo[]> {
  return sorted((await source.snapshot(ScheduleDoc, context))?.items ?? {});
}

/** Remove schedule `id` in the commit of `tx`; its task ends without submitting when it next wakes. */
function remove(registry: ScheduleState, id: number): ScheduleItem | undefined {
  const item = registry.items[String(id)];
  if (item) delete registry.items[String(id)];
  return item;
}

/**
 * Cancel schedule `id` for the host: its record goes in one commit, then its sleeping task is aborted so it does not
 * linger until its time. Resolves with the schedule cancelled; throws NotFound for an unknown id.
 */
export async function cancelSchedule(source: Pick<Session, 'commit'> & { abortTask?(id: TaskId, context: Context): Promise<unknown> },
  context: Context, id: number): Promise<ScheduleInfo> {
  type Removed = { readonly taskId: TaskId; readonly info: ScheduleInfo } | { readonly ids: readonly string[] };
  const result = await source.commit(async (tx): Promise<Removed> => {
    const registry = await tx.doc(ScheduleDoc);
    const item = remove(registry, id);
    // Detached copies: the draft's own objects do not outlive the commit.
    return item ? { taskId: item.taskId, info: { id, text: item.text, at: item.at, ...item.cron === undefined ? {} : { cron: item.cron } } }
      : { ids: Object.keys(registry.items) };
  }, context);
  if ('ids' in result) {
    throw new NotFound(`No schedule #${id}.${result.ids.length ? ` Schedules: ${result.ids.map(each => `#${each}`).join(', ')}.` : ''}`);
  }
  // Best effort: a task that could not be aborted finds no record when it wakes, and ends.
  try { await source.abortTask?.(result.taskId, context); } catch { /* it ends by itself */ }
  return result.info;
}

/** The wake task and how the tools create one. */
function wakes({ routing }: ScheduleOptions) {
  const Wake = defineTask<WakeInput, WakeState, null>({
    name: WAKE_KIND,
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      // The sleep is its own phase: a phase reruns from its top after a restart, so what follows the wait is the next one.
      wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: 'fire', due: task.input.at, n: 0 }, context),
      fire: async (task, runtime, context) => {
        const { id, target } = task.input;
        const { due, n, tries = 0 } = task.state.checkpoint;
        const item = (await runtime.snapshot(ScheduleDoc, context))?.items[String(id)];
        // Cancelled: end without a word.
        if (!item || item.taskId !== task.id) return runtime.commit(done, context);
        const now = runtime.now();
        const cron = item.cron === undefined ? undefined : parseCron(item.cron);
        // A repeating schedule skips the occurrences a closed host missed: one late wake-up, then the next due one.
        const next = cron && nextAfter(cron, Math.max(now, due));
        const requestId = `schedule:${task.id}:${n}`;
        try {
          if (routing) await runtime.commit(async (tx) => { await routing.pin(tx, requestId, target); return undefined; }, context);
          const root = await runtime.conversation(ROOT_CONVERSATION_ID, context);
          if (!root) throw new Error('The root conversation is missing.');
          await root.submit({
            type: 'input', content: fireText(id, item, due, now, next), whenBusy: 'followUp', requestId,
            entry: { kind: FIRE_KIND, data: { id, text: item.text, due, ...item.cron === undefined ? {} : { cron: item.cron } } },
          }, context);
        } catch (error) {
          // A closing host interrupts the phase, and the next launch runs it again. Any other failure is tried again
          // in a minute rather than faulting the task, which would leave a schedule listed that never fires.
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
          if (tries + 1 < DELIVERY_TRIES) return runtime.sleepUntil(now + RETRY_MS, { phase: 'fire', due, n, tries: tries + 1 }, context);
          return runtime.commit(async (tx) => {
            const registry = await tx.doc(ScheduleDoc);
            if (registry.items[String(id)]?.taskId === task.id) delete registry.items[String(id)];
            return { status: 'terminal', outcome: { status: 'failed', error: { message: `Schedule #${id} could not be delivered and was dropped.` } } };
          }, context);
        }
        await runtime.commit(async (tx) => {
          const registry = await tx.doc(ScheduleDoc);
          const current = registry.items[String(id)];
          if (!current || current.taskId !== task.id) return done();
          if (next === undefined) {
            delete registry.items[String(id)];
            return done();
          }
          current.at = next;
          current.fired = n + 1;
          return { status: 'sleeping', until: next, checkpoint: { phase: 'fire', due: next, n: n + 1 } };
        }, context);
      },
    },
    // An aborted wake-up takes its record with it, so no schedule is listed that can never fire.
    abort: (task, runtime, context) => runtime.commit(async (tx) => {
      const registry = await tx.doc(ScheduleDoc);
      if (registry.items[String(task.input.id)]?.taskId === task.id) delete registry.items[String(task.input.id)];
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, context),
  });
  return { Wake };
}

/** Run `change` once per tool call: a replayed call returns the first result. */
async function once(api: ToolExecutionApi, context: Context, change: (tx: Tx, registry: ScheduleState) => Promise<string>): Promise<ToolExecutionResult> {
  const recorded = (await api.snapshot(ScheduleDoc, context))?.calls[api.taskId];
  if (recorded !== undefined) return reply(recorded);
  return reply(await api.commit(async (tx) => {
    const registry = await tx.doc(ScheduleDoc);
    const first = registry.calls[api.taskId];
    if (first !== undefined) return first;
    const result = await change(tx, registry);
    registry.calls[api.taskId] = result;
    const keys = Object.keys(registry.calls);
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_CALLS))) delete registry.calls[key];
    return result;
  }, context));
}

const PI_ONLY = 'Only Pi can schedule; tell Pi what should happen and when.';
const SECTION = [
  'You can leave yourself a message for later with schedule(text, at | in_minutes | cron): a reminder for the user, or a check on something that is not ready yet. It arrives as a new message starting with [Schedule #n], also when the user is away, and you then do what it says and tell the user. Use it instead of waiting or polling.',
  'Write the text for your later self: it is all you will have besides your memory. Times are the host\'s local time, the zone of "now" in the turn block. A cron schedule repeats until cancel_schedule(id); list_schedules() shows them all. Each wake-up is a turn that costs the user, so schedule only what they ask for or would clearly want, and say what you scheduled.',
].join('\n');

/**
 * Build the schedule extension. With `routing` (server mode), a schedule made in a run on a remote machine keeps that
 * machine for its wake-ups; one made on the server follows the server.
 */
export function createScheduleExtension(options: ScheduleOptions = {}): ScheduleExtension {
  const { routing, abortTask } = options;
  const { Wake } = wakes(options);

  const schedule = defineTool({
    name: 'schedule',
    description: 'Leave yourself a message for later: `text` arrives as a new message, starting with [Schedule #n], once at `at` or '
      + 'after `in_minutes`, or again and again on `cron`. Give exactly one of the three. Returns at once with the schedule\'s id. '
      + 'Use it for reminders and for checking back on something, instead of waiting or polling.',
    parameters: obj({
      text: str({ description: 'What to do or tell the user then, complete in itself.' }),
      at: opt(str({ description: 'Once, at this date and time: ISO 8601, such as 2026-11-12T09:00 (the host\'s local time) or with an offset, 2026-11-12T09:00-03:00.' })),
      in_minutes: opt(num({ description: 'Once, this many minutes from now (at least 1).' })),
      cron: opt(str({ description: 'Repeatedly: a 5-field cron expression in the host\'s local time (minute hour day-of-month month day-of-week), such as "0 9 * * 1-5" for weekdays at 9:00. At most every 5 minutes.' })),
    }, { open: true }),
    callers: ['model'],
    replay: 'safe',
    execute: async ({ text, at, in_minutes, cron }, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) return reply(PI_ONLY);
      const message = text.trim();
      if (!message) return reply('text is empty: say what to do or tell the user then.');
      if (message.length > MAX_TEXT) return reply(`text is ${message.length} characters; a schedule carries at most ${MAX_TEXT}.`);
      return once(api, context, async (tx, registry) => {
        // The clock is read in the commit that stores the time, so a replayed call that finds no record computes afresh.
        const now = api.now();
        const first = firstFire({ at, in_minutes, cron }, now);
        if ('error' in first) return first.error;
        if (Object.keys(registry.items).length >= MAX_SCHEDULES) {
          return `There are already ${MAX_SCHEDULES} schedules, the most allowed; cancel one first (list_schedules shows them).`;
        }
        const target = routing ? await routing.current(tx) : undefined;
        if (routing && !target) return 'This run has no machine destination, so nothing can be scheduled from it; schedule from a turn the user sent.';
        const id = registry.next++;
        // The server follows the server: only a remote machine is kept, since the server's own folder may change.
        const kept = target && target.machineId !== 'server' ? { target: { machineId: target.machineId, cwd: target.cwd, label: target.label } } : {};
        const taskId = await tx.createTask(Wake, { id, at: first.at, ...kept }, TASK_OPTIONS);
        const item: ScheduleItem = { taskId, text: message, at: first.at, createdAt: now, fired: 0, ...first.cron === undefined ? {} : { cron: first.cron } };
        registry.items[String(id)] = item;
        const where = kept.target ? ` Its tools run on ${kept.target.label}, in ${kept.target.cwd}.` : '';
        return first.cron === undefined
          ? `Scheduled #${id} for ${formatDate(first.at)}.${where} cancel_schedule(${id}) cancels it.`
          : `Scheduled #${id}: cron "${first.cron}", first on ${formatDate(first.at)}.${where} It repeats until cancel_schedule(${id}).`;
      });
    },
  });

  const list = defineTool({
    name: 'list_schedules',
    description: 'List your schedules: id, once or cron, when each next fires, and its text.',
    parameters: obj({}, { open: true }),
    callers: ['model'],
    replay: 'safe',
    execute: async (_args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) return reply(PI_ONLY);
      const all = await listSchedules(api, context);
      return reply(all.length ? `now: ${formatDate(api.now())}\n${all.map(line).join('\n')}` : 'No schedules.');
    },
  });

  const cancel = defineTool({
    name: 'cancel_schedule',
    description: 'Cancel a schedule by its id, so it never fires again.',
    parameters: obj({ id: int({ minimum: 1, description: 'The schedule\'s id, as schedule and list_schedules give it.' }) }, { open: true }),
    callers: ['model'],
    replay: 'safe',
    execute: async ({ id }, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) return reply(PI_ONLY);
      const taskId = (await api.snapshot(ScheduleDoc, context))?.items[String(id)]?.taskId;
      const result = await once(api, context, async (_tx, registry) => {
        const item = remove(registry, id);
        if (item) return `Cancelled #${id} (${item.cron === undefined ? 'once' : `cron "${item.cron}"`}): ${item.text}`;
        const ids = Object.keys(registry.items);
        return `No schedule #${id}. ${ids.length ? `Schedules: ${ids.map(each => `#${each}`).join(', ')}.` : 'There are none.'}`;
      });
      // Best effort, after the record is gone: a task still asleep finds none when it wakes, and ends.
      if (taskId !== undefined) await abortTask?.(taskId, context).catch(() => undefined);
      return result;
    },
  });

  // Typed as ScheduleExtension rather than through defineExtension (an identity), so `tools` stays required.
  return {
    name: SCHEDULE_EXTENSION,
    tasks: [Wake],
    tools: [schedule, list, cancel],
    sections: [section('schedule', input => input.conversationId === ROOT_CONVERSATION_ID
      && input.agent.tools.some(tool => tool.name === 'schedule') ? SECTION : undefined)],
  };
}
