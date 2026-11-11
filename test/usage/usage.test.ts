import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import { localDay } from '../../src/memory/util.ts';
import { openInstance, type Instance, type InstanceOptions } from '../../src/runtime/runtime.ts';
import { applySample, countsOf, createUsageTracker, HostUsageDoc, KEEP_DAYS, usageReport } from '../../src/usage/index.ts';
import type { Counts, HostUsage, Totals } from '../../src/usage/index.ts';
import type { UsageRow } from '../../src/protocol/session.ts';
import { router, say, type Script } from '../fixtures/agents-instance.ts';
import { offlineModels } from '../fixtures/faux-model.ts';

const DAY = 86_400_000;
/** Local times, so the tests hold in any zone. */
const local = (year: number, month: number, day: number, hour = 0, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const T0 = local(2026, 11, 10, 14, 3);
const day = (at: number): string => localDay(new Date(at));
const counts = (input: number, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0): Counts => ({ input, output, cacheRead, cacheWrite, cost });
const row = (model: string, ...spent: Parameters<typeof counts>): UsageRow => ({ model, ...counts(...spent) });
const fresh = (): HostUsage => ({ since: 0, last: {}, days: {}, extra: {} });

describe('the usage buckets', () => {
  test('the first sample records the totals so far, in no day', () => {
    const state = fresh();
    const totals: Totals = { 'p/a': counts(100, 20, 300, 40, 1.5) };
    assert.deepEqual(usageReport(state, totals, T0), { today: [], week: [], all: [row('p/a', 100, 20, 300, 40, 1.5)] }, 'before any sample');
    assert.equal(applySample(state, totals, {}, T0), true);
    assert.deepEqual(state, { since: T0, last: totals, days: {}, extra: {} });
    assert.notEqual(state.last['p/a'], totals['p/a'], 'the state keeps its own copy');
    assert.deepEqual(usageReport(state, totals, T0), { today: [], week: [], all: [row('p/a', 100, 20, 300, 40, 1.5)], since: T0 });
    assert.equal(applySample(state, totals, {}, T0 + 60_000), false, 'nothing spent, nothing to store');
  });

  test('what the totals grew by lands on the local day of the sample', () => {
    const state = fresh();
    applySample(state, { 'p/a': counts(100, 20) }, {}, T0);
    assert.equal(applySample(state, { 'p/a': counts(150, 25, 10, 0, 0.5), 'p/b': counts(30, 1) }, {}, T0 + 3_600_000), true);
    assert.deepEqual(state.days, { [day(T0)]: { 'p/a': counts(50, 5, 10, 0, 0.5), 'p/b': counts(30, 1) } }, 'a model first seen later counts whole');
    applySample(state, { 'p/a': counts(160, 25, 10, 0, 0.5), 'p/b': counts(30, 1) }, {}, T0 + 2 * 3_600_000);
    assert.deepEqual(state.days[day(T0)]?.['p/a'], counts(60, 5, 10, 0, 0.5), 'a day adds up');
    const next = local(2026, 11, 11, 0, 30);
    const totals = { 'p/a': counts(160, 25, 10, 0, 0.5), 'p/b': counts(430, 9) };
    applySample(state, totals, {}, next);
    assert.deepEqual(state.days[day(next)], { 'p/b': counts(400, 8) });
    assert.deepEqual(usageReport(state, totals, next), {
      today: [row('p/b', 400, 8)],
      week: [row('p/b', 430, 9), row('p/a', 60, 5, 10, 0, 0.5)],
      all: [row('p/b', 430, 9), row('p/a', 160, 25, 10, 0, 0.5)],
      since: T0,
    }, 'rows have the most tokens first');
  });

  test('the week is the last 7 local days, today included; rows without spend are left out', () => {
    const now = local(2026, 11, 10, 9);
    const state: HostUsage = { ...fresh(), since: 1, days: {
      [day(local(2026, 11, 10))]: { 'p/a': counts(1) }, [day(local(2026, 11, 4, 23))]: { 'p/a': counts(10), 'p/zero': counts(0) },
      [day(local(2026, 11, 3, 23))]: { 'p/a': counts(100) },
    } };
    const report = usageReport(state, { 'p/a': counts(111), 'p/zero': counts(0) }, now);
    assert.deepEqual(report, { today: [row('p/a', 1)], week: [row('p/a', 11)], all: [row('p/a', 111)], since: 1 });
    assert.deepEqual(usageReport(state, {}, local(2026, 11, 11, 0, 1)).week, [row('p/a', 1)], 'a new day moves the window');
  });

  test(`days older than ${KEEP_DAYS} days are dropped`, () => {
    const now = local(2026, 11, 10, 9);
    const kept = day(now - KEEP_DAYS * DAY + 3_600_000), old = day(now - (KEEP_DAYS + 1) * DAY + 3_600_000);
    const state: HostUsage = { ...fresh(), since: 1, days: { [old]: { 'p/a': counts(1) }, [kept]: { 'p/a': counts(2) }, [day(now)]: { 'p/a': counts(3) } } };
    assert.equal(applySample(state, {}, {}, now), true);
    assert.deepEqual(Object.keys(state.days).sort(), [kept, day(now)].sort());
    assert.equal(applySample(state, {}, {}, now), false);
  });

  test('a total that shrank counts as nothing, and counting goes on from it', () => {
    const state = fresh();
    applySample(state, { 'p/a': counts(100, 5, 50, 0, 2) }, {}, T0);
    applySample(state, { 'p/a': counts(80, 9, 50, 0, 1) }, {}, T0 + 1000);
    assert.deepEqual(state.days[day(T0)], { 'p/a': counts(0, 4) });
    assert.deepEqual(state.last, { 'p/a': counts(80, 9, 50, 0, 1) });
    applySample(state, { 'p/a': counts(90, 9, 50, 0, 1.5) }, {}, T0 + 2000);
    assert.deepEqual(state.days[day(T0)], { 'p/a': counts(10, 4, 0, 0, 0.5) });
  });

  test('compaction spend is kept in extra, and counts today, in the week and in all time', () => {
    const state = fresh();
    // On the first sample too: it was spent by this launch.
    applySample(state, { 'p/a': counts(100) }, { 'p/cheap': counts(7, 1, 0, 0, 0.25) }, T0);
    assert.deepEqual(state.days, { [day(T0)]: { 'p/cheap': counts(7, 1, 0, 0, 0.25) } });
    assert.equal(applySample(state, { 'p/a': counts(110) }, { 'p/cheap': counts(3, 1, 0, 0, 0.25), 'p/a': counts(5), 'p/none': counts(0) }, T0 + 1000), true);
    assert.deepEqual(state.extra, { 'p/cheap': counts(10, 2, 0, 0, 0.5), 'p/a': counts(5) });
    const spent = [row('p/a', 15), row('p/cheap', 10, 2, 0, 0, 0.5)];
    assert.deepEqual(usageReport(state, { 'p/a': counts(110) }, T0 + 1000),
      { today: spent, week: spent, all: [row('p/a', 115), row('p/cheap', 10, 2, 0, 0, 0.5)], since: T0 });
  });
});

interface Host {
  instance: Instance;
  readonly cwd: string;
  /** The faux model's key in the report. */
  readonly model: string;
  /** The host's clock; tests move it. */
  now: number;
  reopen(extra?: Partial<InstanceOptions>): Promise<Instance>;
}

/** A local chat on a faux model that `script` answers for, on a clock the test moves. */
async function open(t: TestContext, script: Script, extra: Partial<InstanceOptions> = {}): Promise<Host> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-durable-usage-'));
  const catalog = offlineModels(router(script));
  const clock = { now: T0 };
  const launch = (more: Partial<InstanceOptions> = {}): Promise<Instance> => openInstance({ protection: 'unguarded', databasePath: join(cwd, 'chat.sqlite'), cwd,
    models: catalog.models, model: catalog.model, rosterChecks: false, clock: () => clock.now, ...extra, ...more });
  const host: Host = {
    instance: await launch(), cwd, model: `${catalog.model.provider}/${catalog.model.modelId}`,
    get now() { return clock.now; },
    set now(at: number) { clock.now = at; },
    async reopen(more) {
      await host.instance.close();
      return host.instance = await launch(more);
    },
  };
  t.after(async () => {
    await host.instance.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });
  return host;
}

async function ask({ instance }: Host, text: string): Promise<void> {
  const settled = await (await instance.submit(text)).wait(instance.context);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** What pi-durable itself counted for the host's model. */
async function sdk({ instance, model }: Host): Promise<Counts> {
  const usage = (await instance.harness.usage(instance.context)).models[model];
  assert.ok(usage, 'the SDK counted the model');
  return countsOf(usage);
}
const stored = ({ instance }: Host) => instance.harness.snapshot(HostUsageDoc, instance.context);

describe('the usage report of a chat (offline)', { concurrency: false, timeout: 60_000 }, () => {
  test('a turn\'s tokens show today, in the week and in all time, by local day, across launches', async (t) => {
    const host = await open(t, { Pi: () => say('Hello there.') });
    assert.deepEqual(await host.instance.usage(), { today: [], week: [], all: [], since: T0 }, 'the launch sampled an empty chat');
    await ask(host, 'hi');
    const first = await sdk(host);
    assert.ok(first.output > 0 && first.input + first.cacheWrite > 0, JSON.stringify(first));
    const spent = [{ model: host.model, ...first }];
    assert.deepEqual(await host.instance.usage(), { today: spent, week: spent, all: spent, since: T0 });

    // The next local day, after a restart: the first day stays in the week.
    host.now = local(2026, 11, 11, 9);
    await host.reopen();
    assert.deepEqual(await host.instance.usage(), { today: [], week: spent, all: spent, since: T0 });
    await ask(host, 'again');
    const total = await sdk(host);
    const report = await host.instance.usage();
    assert.deepEqual(report.all, [{ model: host.model, ...total }]);
    assert.deepEqual(report.week, report.all);
    assert.equal(report.today[0]?.output, total.output - first.output);
    assert.deepEqual(Object.keys((await stored(host))?.days ?? {}), [day(T0), day(host.now)]);

    // Eight days on, the week is empty and all time is whole.
    host.now = local(2026, 11, 19, 9);
    assert.deepEqual(await host.instance.usage(), { today: [], week: [], all: report.all, since: T0 });
  });

  test('a running host samples on its timer, and a closing one samples what is left', async (t) => {
    const host = await open(t, { Pi: () => say('Hello there.') }, { usageSampleMs: 20 });
    await ask(host, 'hi');
    const first = await sdk(host);
    await until(async () => (await stored(host))?.days[day(T0)]?.[host.model]?.output === first.output, 'the timer\'s sample');

    await host.reopen({ usageSampleMs: 3_600_000 });
    await ask(host, 'again');
    const total = await sdk(host);
    assert.equal((await stored(host))?.days[day(T0)]?.[host.model]?.output, first.output, 'not sampled yet');
    // An inspection reads what the close stored.
    await host.reopen({ configureAgent: false });
    assert.deepEqual((await host.instance.usage()).today, [{ model: host.model, ...total }]);
  });

  test('an inspection reports without writing', async (t) => {
    const host = await open(t, { Pi: () => say('Hello there.') }, { configureAgent: false });
    assert.deepEqual(await host.instance.usage(), { today: [], week: [], all: [] }, 'no since: nothing was ever sampled');
    assert.equal(await stored(host), undefined, 'and the report sampled nothing');

    await host.reopen({ configureAgent: true });
    await ask(host, 'hi');
    const spent = [{ model: host.model, ...await sdk(host) }];
    await host.reopen({ configureAgent: false });
    const before = await stored(host);
    host.now = local(2026, 11, 11, 9);
    assert.deepEqual(await host.instance.usage(), { today: [], week: spent, all: spent, since: T0 });
    assert.deepEqual(await stored(host), before);
    // A tracker that may not write leaves unsampled spend out of the days, and in all time.
    const grown: Totals = { [host.model]: { ...spent[0] ?? counts(0), output: 1_000_000 } };
    const { harness } = host.instance;
    const reader = createUsageTracker({ harness: () => ({ usage: () => Promise.resolve({ models: usageOf(grown), tools: {} }),
      snapshot: harness.snapshot.bind(harness), commit: () => Promise.reject(new Error('an inspection wrote')) }),
    context: host.instance.context, clock: () => host.now, write: false });
    await reader.sample();
    const report = await reader.report();
    assert.equal(report.all[0]?.output, 1_000_000);
    assert.deepEqual(report.week, spent);
  });

  test('the memory\'s compactions count too, though pi-durable never sees them', async (t) => {
    const host = await open(t, { Pi: () => say('Noted.'), unknown: () => say('The user wrote a long note about the tide.') });
    // Over 512 bytes, so its leaf takes a compaction call.
    await ask(host, `a long note: ${'the tide comes in and the tide goes out; '.repeat(20)}`);
    const memory = host.instance.memory;
    assert.ok(memory);
    await until(() => memory.status().unsummarized === 0 && memory.status().active === 0, 'the compaction');
    const report = await host.instance.usage();
    const turns = await sdk(host), extra = (await stored(host))?.extra[host.model];
    assert.ok(extra && extra.output > 0, JSON.stringify(extra));
    assert.equal(report.all[0]?.output, turns.output + extra.output);
    assert.deepEqual(report.today, report.all);
    // It survives a restart, where the SDK's totals alone would forget it.
    await host.reopen();
    assert.deepEqual((await host.instance.usage()).all, report.all);
  });
});

/** `totals` as pi-durable reports usage. */
function usageOf(totals: Totals) {
  return Object.fromEntries(Object.entries(totals).map(([model, each]) => [model, { input: each.input, output: each.output,
    cacheRead: each.cacheRead, cacheWrite: each.cacheWrite, totalTokens: each.input + each.output + each.cacheRead + each.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: each.cost } }]));
}
