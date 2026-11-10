import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import type { JsonObject, ToolExecutionResult } from '@earendil-works/pi-durable';
import { AgentsDoc } from '../../src/agents/index.ts';
import { createUiSession } from '../../src/session/session.ts';
import { SubmissionRouteDoc, type RoutingDispatcher } from '../../src/runtime/routing.ts';
import { TURN_HEAD } from '../../src/memory/extension.ts';
import { formatDate } from '../../src/memory/util.ts';
import type { MachineTarget } from '../../src/protocol/machines.ts';
import { isWork, resumeInstance } from '../../src/runtime/recovery.ts';
import { openInstance, transcript, type Instance, type InstanceOptions } from '../../src/runtime/runtime.ts';
import {
  cancelSchedule, FIRE_KIND, fireText, firstFire, LATE_MS, listSchedules, MAX_SCHEDULES, MAX_TEXT, scheduleFireOf, WAKE_KIND,
} from '../../src/schedule/index.ts';
import { NotFound } from '../../src/protocol/errors.ts';
import { call, router, say, type Script, type Turn } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const MINUTE = 60_000, DAY = 86_400_000;
/** Local times, so the tests hold in any zone. 2026-11-10 is a Tuesday. */
const local = (year: number, month: number, day: number, hour = 0, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const T0 = local(2026, 11, 10, 14, 0);
/** The run's new message, without the memory view that precedes it. */
const said = (user: string): string => user.includes(TURN_HEAD) ? user.slice(user.lastIndexOf(TURN_HEAD) + TURN_HEAD.length) : user;

interface Host {
  instance: Instance;
  readonly cwd: string;
  readonly seen: Turn[];
  /** The host's clock; tests move it. */
  now: number;
  reopen(): Promise<Instance>;
}

/** A local chat on a faux model that `script` answers for, on a clock the test moves. */
async function open(t: TestContext, script: Script, extra: Partial<InstanceOptions> = {}): Promise<Host> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-schedule-'));
  const seen: Turn[] = [];
  const catalog = offlineModels(router(script, seen));
  const clock = { now: T0 };
  const launch = (): Promise<Instance> => openInstance({ protection: 'unguarded', databasePath: join(cwd, 'chat.sqlite'), cwd, models: catalog.models,
    model: catalog.model, rosterChecks: false, clock: () => clock.now, ...extra });
  const host: Host = {
    instance: await launch(), cwd, seen,
    get now() { return clock.now; },
    set now(at: number) { clock.now = at; },
    async reopen() { return host.instance = await launch(); },
  };
  t.after(async () => {
    await host.instance.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  return host;
}

async function ask({ instance }: Host, text: string): Promise<string> {
  const settled = await (await instance.submit(text)).wait(instance.context);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  const answers = (await transcript(instance.root, instance.context)).flatMap(entry => entry.kind === 'pi.assistant' ? entry.model ?? [] : [])
    .flatMap(message => message.role === 'assistant' ? [message.content.map(block => block.type === 'text' ? block.text : '').join('')] : []);
  return answers.at(-1) ?? '';
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** The wake-ups Pi's conversation holds, oldest first. */
const fires = async ({ instance }: Host) => (await transcript(instance.root, instance.context)).flatMap(entry => {
  const fire = scheduleFireOf(entry);
  return fire ? [fire] : [];
});
const wakeTasks = async ({ instance }: Host) => (await instance.harness.inspect(instance.context)).tasks.filter(task => task.record.kind === WAKE_KIND);
/** Move the clock to `at`, as time passing does, and let the Harness look at it. */
async function advance(host: Host, at: number): Promise<void> {
  host.now = at;
  host.instance.harness.resume();
  await delay(30);
}
const idle = ({ instance }: Host) => instance.root.waitForIdle(instance.context);

describe('scheduled wake-ups (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('when a schedule first fires: exactly one of at, in_minutes and cron, with readable refusals', () => {
    assert.deepEqual(firstFire({ in_minutes: 30 }, T0), { at: T0 + 30 * MINUTE });
    assert.deepEqual(firstFire({ in_minutes: 1.5 }, T0), { at: T0 + 90_000 });
    assert.deepEqual(firstFire({ at: '2026-11-12T09:00' }, T0), { at: local(2026, 11, 12, 9) });
    assert.deepEqual(firstFire({ at: '2026-11-12 09:00:30' }, T0), { at: local(2026, 11, 12, 9) + 30_000 });
    assert.deepEqual(firstFire({ at: '2026-11-12T09:00:00Z' }, T0), { at: Date.UTC(2026, 10, 12, 9) });
    assert.deepEqual(firstFire({ at: '2026-11-12T09:00-03:00' }, T0), { at: Date.UTC(2026, 10, 12, 12) });
    assert.deepEqual(firstFire({ cron: ' 0  9 * * 1-5 ' }, T0), { at: local(2026, 11, 11, 9), cron: '0 9 * * 1-5' });
    const refused = (args: Parameters<typeof firstFire>[0], pattern: RegExp): void => {
      const result = firstFire(args, T0);
      assert.ok('error' in result && pattern.test(result.error), JSON.stringify(result));
    };
    refused({}, /exactly one of at, in_minutes or cron/);
    refused({ at: '2026-11-12T09:00', in_minutes: 5 }, /exactly one/);
    refused({ in_minutes: 0 }, /at least 1/);
    refused({ in_minutes: Number.NaN }, /at least 1/);
    refused({ in_minutes: 3 * 366 * 24 * 60 }, /two years/);
    refused({ at: 'tomorrow at nine' }, /is not a date and time such as/);
    refused({ at: '2026-11-12' }, /is not a date and time/);
    refused({ at: '2026-11-10T13:59' }, /is in the past: now is 2026-11-10 14:00:00/);
    refused({ at: '2030-01-01T00:00' }, /more than two years ahead/);
    refused({ cron: '0 9 * *' }, /Invalid cron "0 9 \* \*": a cron expression has 5 fields/);
    refused({ cron: '* * * * *' }, /fires 1 min apart; a schedule repeats at most every 5 minutes/);
    refused({ cron: '0 0 30 2 *' }, /matches no time in the next five years/);
  });

  test('the message a wake-up arrives as says when it was due, whether it is late, and how a repeating one stops', () => {
    const item = { text: 'Check the deploy.', createdAt: T0 };
    const due = T0 + 30 * MINUTE;
    assert.equal(fireText(3, item, due, due + 1_000),
      `[Schedule #3] Check the deploy.\n\n(A wake-up you scheduled on ${formatDate(T0)}, due ${formatDate(due)}.)`);
    assert.match(fireText(3, item, due, due + LATE_MS + 1), /due .*; delivered late, at .*: the host was not running then\.\)$/);
    assert.match(fireText(3, { ...item, cron: '0 9 * * *' }, due, due, due + DAY),
      /\. It repeats \(cron "0 9 \* \* \*", next .*\); cancel_schedule\(3\) stops it\.\)$/);
  });

  test('a one-off: Pi schedules it, it sleeps, then reaches Pi once as a new turn, the memory and the chat', async (t) => {
    const host = await open(t, { Pi: ({ user, last }) => {
      const text = said(user);
      if (text === 'Remind me in half an hour.') {
        return last ? say(last.text) : call(['schedule', { text: 'Tell the user to call the dentist.', in_minutes: 30 }]);
      }
      return say(text.startsWith('[Schedule #1]') ? 'Reminder: call the dentist.' : 'ok');
    } });
    const due = T0 + 30 * MINUTE;
    assert.equal(await ask(host, 'Remind me in half an hour.'), `Scheduled #1 for ${formatDate(due)}. cancel_schedule(1) cancels it.`);
    assert.deepEqual(await listSchedules(host.instance.harness, host.instance.context),
      [{ id: 1, text: 'Tell the user to call the dentist.', at: due }]);
    const [task] = await wakeTasks(host);
    assert.deepEqual(task?.state, { kind: 'sleeping', until: due });
    assert.equal(task && isWork(task), false, 'a sleeping schedule is not pending work');

    await advance(host, due - 1);
    assert.deepEqual(await fires(host), [], 'not due yet');
    await advance(host, due);
    await until(async () => (await fires(host)).length === 1, 'the wake-up');
    await idle(host);
    assert.deepEqual(await fires(host), [{ id: 1, text: 'Tell the user to call the dentist.', due }]);
    const turn = host.seen.findLast(each => said(each.user).startsWith('[Schedule #1]'));
    assert.equal(said(turn?.user ?? ''),
      `[Schedule #1] Tell the user to call the dentist.\n\n(A wake-up you scheduled on ${formatDate(T0)}, due ${formatDate(due)}.)`);
    await until(async () => (await wakeTasks(host)).length === 0, 'the wake task to end');
    assert.deepEqual(await listSchedules(host.instance.harness, host.instance.context), []);

    // The memory logs it as a background task's word, not the user's.
    const logged = host.instance.memory?.log.filter(record => record.text.startsWith('[Schedule #1]')) ?? [];
    assert.deepEqual(logged.map(record => record.kind), ['work']);
    // Clients see it as a report from "Schedule #1", then Pi's answer.
    const session = await createUiSession(host.instance, { model: { provider: 'faux', modelId: 'x' }, thinkingLevel: 'off', allowTools: false });
    try {
      const items = session.chat.items().filter(item => item.kind === 'report' || item.kind === 'assistant').slice(-2);
      assert.deepEqual(items.map(item => item.kind === 'report' ? `${item.from}: ${item.text}` : item.kind === 'assistant' ? item.text : ''),
        ['Schedule #1: Tell the user to call the dentist.', 'Reminder: call the dentist.']);
      assert.deepEqual(session.status().schedules, []);
    } finally { await session.close(); }

    // Time going on, and a relaunch, deliver nothing more.
    await advance(host, due + DAY);
    await host.instance.close();
    await resumeInstance(await host.reopen());
    assert.equal((await fires(host)).length, 1);
  });

  test('a repeating schedule fires on its cron, skips what a closed host missed with one late wake-up, and stops when cancelled', async (t) => {
    const host = await open(t, { Pi: ({ user, last }) => {
      const text = said(user);
      if (text === 'Every morning.') return last ? say(last.text) : call(['schedule', { text: 'Morning summary.', cron: '0 9 * * *' }]);
      if (text === 'What is scheduled?') return last ? say(last.text) : call(['list_schedules', {}]);
      if (text === 'Stop it.') return last ? say(last.text) : call(['cancel_schedule', { id: 1 }]);
      if (text === 'Stop it again.') return last ? say(last.text) : call(['cancel_schedule', { id: 1 }]);
      return say('Good morning.');
    } });
    const day = (n: number): number => local(2026, 11, 10 + n, 9);
    assert.equal(await ask(host, 'Every morning.'),
      `Scheduled #1: cron "0 9 * * *", first on ${formatDate(day(1))}. It repeats until cancel_schedule(1).`);

    await advance(host, day(1));
    await until(async () => (await fires(host)).length === 1, 'the first morning');
    await idle(host);
    await until(async () => (await wakeTasks(host))[0]?.state.kind === 'sleeping', 'the next sleep');
    assert.deepEqual(await listSchedules(host.instance.harness, host.instance.context),
      [{ id: 1, text: 'Morning summary.', at: day(2), cron: '0 9 * * *' }]);
    assert.match(said(host.seen.at(-1)?.user ?? ''), new RegExp(`It repeats \\(cron "0 9 \\* \\* \\*", next ${formatDate(day(2)).replace(/[+()]/g, '\\$&')}\\)`));
    assert.equal(await ask(host, 'What is scheduled?'),
      `now: ${formatDate(day(1))}\n#1 cron "0 9 * * *", next ${formatDate(day(2))}: Morning summary.`);

    // The host is closed over three mornings and reopens at 10:00 on the fourth day: one wake-up, late.
    await host.instance.close();
    host.now = day(4) + 60 * MINUTE;
    await resumeInstance(await host.reopen());
    await until(async () => (await fires(host)).length === 2, 'the late morning');
    await idle(host);
    await until(async () => (await wakeTasks(host))[0]?.state.kind === 'sleeping', 'the next sleep');
    assert.deepEqual((await fires(host)).map(fire => fire.due), [day(1), day(2)], 'due on the second day');
    assert.match(said(host.seen.at(-1)?.user ?? ''), /delivered late, at .*: the host was not running then/);
    assert.deepEqual((await listSchedules(host.instance.harness, host.instance.context)).map(each => each.at), [day(5)], 'the missed mornings are skipped');

    assert.equal(await ask(host, 'Stop it.'), 'Cancelled #1 (cron "0 9 * * *"): Morning summary.');
    assert.equal(await ask(host, 'Stop it again.'), 'No schedule #1. There are none.');
    assert.deepEqual(await listSchedules(host.instance.harness, host.instance.context), []);
    // Its sleeping task is aborted with it, and the next morning brings nothing.
    await until(async () => (await wakeTasks(host)).length === 0, 'the cancelled task to end');
    await advance(host, day(5));
    assert.equal((await fires(host)).length, 2);
  });

  test('refusals are the tool\'s text: a bad time, an empty or huge text, and the 33rd schedule', async (t) => {
    const many = Array.from({ length: MAX_SCHEDULES + 1 }, (_, n): readonly [string, JsonObject] => ['schedule', { text: `Note ${n}.`, in_minutes: 10 + n }]);
    const host = await open(t, { Pi: ({ user, results }) => {
      const text = said(user);
      if (results.length) return say(results.map(result => result.text).join('\n'));
      if (text === 'Bad time.') return call(['schedule', { text: 'x', at: '2026-11-10T13:00' }]);
      if (text === 'Two times.') return call(['schedule', { text: 'x', in_minutes: 5, cron: '0 9 * * *' }]);
      if (text === 'Nothing.') return call(['schedule', { text: '   ', in_minutes: 5 }]);
      if (text === 'Too long.') return call(['schedule', { text: 'x'.repeat(MAX_TEXT + 1), in_minutes: 5 }]);
      if (text === 'Many.') return call(...many);
      return say('ok');
    } });
    assert.match(await ask(host, 'Bad time.'), /^at 2026-11-10T13:00 is in the past: now is 2026-11-10 14:00:00/);
    assert.equal(await ask(host, 'Two times.'), 'Give exactly one of at, in_minutes or cron.');
    assert.equal(await ask(host, 'Nothing.'), 'text is empty: say what to do or tell the user then.');
    assert.equal(await ask(host, 'Too long.'), `text is ${MAX_TEXT + 1} characters; a schedule carries at most ${MAX_TEXT}.`);
    assert.deepEqual(await listSchedules(host.instance.harness, host.instance.context), [], 'a refusal schedules nothing');
    const answers = (await ask(host, 'Many.')).split('\n');
    assert.equal(answers.filter(line => line.startsWith('Scheduled #')).length, MAX_SCHEDULES);
    assert.deepEqual(answers.filter(line => !line.startsWith('Scheduled #')),
      [`There are already ${MAX_SCHEDULES} schedules, the most allowed; cancel one first (list_schedules shows them).`]);
    const all = await listSchedules(host.instance.harness, host.instance.context);
    assert.equal(all.length, MAX_SCHEDULES);
    assert.deepEqual(all.map(each => each.at), [...all.map(each => each.at)].sort((a, b) => a - b), 'soonest first');
  });

  test('the host cancels a schedule and its task; the session lists schedules and cancels by id', async (t) => {
    const host = await open(t, { Pi: ({ user, last }) => {
      if (last) return say(last.text);
      const minutes = /in (\d+)/.exec(said(user))?.[1];
      return minutes ? call(['schedule', { text: `After ${minutes}.\nSecond line.`, in_minutes: Number(minutes) }]) : say('ok');
    } });
    await ask(host, 'in 20');
    await ask(host, 'in 10');
    const { harness, context } = host.instance;
    await assert.rejects(cancelSchedule(harness, context, 9), (error: unknown) => error instanceof NotFound && error.message === 'No schedule #9. Schedules: #1, #2.');
    assert.deepEqual(await cancelSchedule(harness, context, 1), { id: 1, text: 'After 20.\nSecond line.', at: T0 + 20 * MINUTE });
    await until(async () => (await wakeTasks(host)).length === 1, 'the cancelled schedule\'s task to end');

    const session = await createUiSession(host.instance, { model: { provider: 'faux', modelId: 'x' }, thinkingLevel: 'off', allowTools: false }, { refreshMs: 20 });
    try {
      assert.deepEqual(session.status().schedules, [{ id: 2, text: 'After 10. Second line.', at: T0 + 10 * MINUTE }], 'a one-line preview');
      await assert.rejects(session.cancelSchedule(1), NotFound);
      await session.cancelSchedule(2);
      assert.deepEqual(session.status().schedules, [], 'the status shows the change once the cancel resolves');
    } finally { await session.close(); }
    await until(async () => (await wakeTasks(host)).length === 0, 'both tasks to end');
    await advance(host, T0 + DAY);
    assert.deepEqual(await fires(host), []);
  });

  test('schedules are Pi\'s alone: an agent is neither offered the tools nor told about them', async (t) => {
    const host = await open(t, {
      Pi: ({ user, last }) => said(user) === 'Start Bob.' && !last ? call(['spawn_agent', { name: 'Bob', task: 'Wait.' }]) : say('ok'),
      Bob: () => say('Bob done.'),
    });
    await ask(host, 'Start Bob.');
    const { harness, context, root } = host.instance;
    const pi = await root.agent(context);
    assert.deepEqual(pi.tools.map(tool => tool.name).filter(name => name.includes('schedule')).sort(), ['cancel_schedule', 'list_schedules', 'schedule']);
    const id = (await harness.snapshot(AgentsDoc, context))?.agents.Bob?.conversationId;
    assert.ok(id !== undefined);
    const bob = await (await harness.conversation(id, context))?.agent(context);
    assert.ok(bob);
    assert.deepEqual(bob.tools.map(tool => tool.name).filter(name => name.includes('schedule')), []);
    const system = (who: string): string => JSON.stringify(host.seen.find(turn => turn.who === who)?.request.messages.filter(message => message.role === 'system'));
    assert.match(system('Pi'), /leave yourself a message for later with schedule\(/);
    assert.doesNotMatch(system('Bob'), /schedule\(/);
  });

  test('with machine routing, a schedule keeps the remote machine it was made on, and one made on the server follows the server', async (t) => {
    const laptop: MachineTarget = { machineId: 'laptop', cwd: '/remote/project', label: 'My laptop' };
    const calls: { target: MachineTarget; name: string }[] = [];
    const dispatcher: RoutingDispatcher = {
      execute(target, _id, name): Promise<ToolExecutionResult> {
        calls.push({ target, name });
        return Promise.resolve({ output: [{ type: 'text', text: 'remote result' }] });
      },
    };
    const host = await open(t, { Pi: ({ user, last }) => {
      const text = said(user);
      if (text.startsWith('Remind')) return last ? say(last.text) : call(['schedule', { text: `From ${text}`, in_minutes: text.includes('laptop') ? 10 : 20 }]);
      if (text.startsWith('[Schedule')) return last ? say('Read it.') : call(['read', { path: 'notes.txt' }]);
      return say('ok');
    } }, { dispatcher, allowTools: true });
    const { instance } = host;
    const send = async (text: string, target?: MachineTarget): Promise<string> => {
      const settled = await (await instance.submit(text, target ? { target } : {})).wait(instance.context);
      assert.equal(settled.status, 'done', JSON.stringify(settled));
      return (await transcript(instance.root, instance.context)).flatMap(entry => entry.kind === 'pi.assistant' ? entry.model ?? [] : [])
        .flatMap(message => message.role === 'assistant' ? [message.content.map(block => block.type === 'text' ? block.text : '').join('')] : []).at(-1) ?? '';
    };
    assert.match(await send('Remind laptop', laptop), /^Scheduled #1 for .*\. Its tools run on My laptop, in \/remote\/project\. cancel_schedule\(1\)/);
    assert.match(await send('Remind server'), /^Scheduled #2 for [^.]*\. cancel_schedule\(2\) cancels it\.$/);
    const tasks = await wakeTasks(host);
    assert.deepEqual(tasks.map(task => task.record.input), [{ id: 1, at: T0 + 10 * MINUTE, target: laptop }, { id: 2, at: T0 + 20 * MINUTE }]);
    const route = async (n: number) => (await instance.harness.snapshot(SubmissionRouteDoc, instance.root.id,
      `request:schedule:${String(tasks[n]?.record.id)}:0`, instance.context))?.target;

    // The laptop's wake-up runs its tools on the laptop.
    await advance(host, T0 + 10 * MINUTE);
    await until(async () => (await fires(host)).length === 1, 'the laptop wake-up');
    await idle(host);
    assert.deepEqual(await route(0), laptop);
    assert.deepEqual(calls, [{ target: laptop, name: 'read' }]);
    // The server's runs them on the server, in the server's folder as it is then: nothing is dispatched.
    await advance(host, T0 + 20 * MINUTE);
    await until(async () => (await fires(host)).length === 2, 'the server wake-up');
    await idle(host);
    assert.deepEqual(await route(1), { machineId: 'server', cwd: host.cwd, label: 'server' });
    assert.equal(calls.length, 1);
  });
});

test('a wake-up entry decodes only from its own kind and shape', () => {
  assert.deepEqual(scheduleFireOf({ kind: FIRE_KIND, data: { id: 2, text: 'x', due: 5, cron: '0 9 * * *', extra: 1 } }), { id: 2, text: 'x', due: 5, cron: '0 9 * * *' });
  assert.deepEqual(scheduleFireOf({ kind: FIRE_KIND, data: { id: 2, text: 'x', due: 5 } }), { id: 2, text: 'x', due: 5 });
  assert.equal(scheduleFireOf({ kind: 'pi.user', data: { id: 2, text: 'x', due: 5 } }), undefined);
  assert.equal(scheduleFireOf({ kind: FIRE_KIND, data: { id: '2', text: 'x', due: 5 } }), undefined);
  assert.equal(scheduleFireOf({ kind: FIRE_KIND }), undefined);
});
