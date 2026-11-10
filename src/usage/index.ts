import type { Context } from '@earendil-works/chord/context';
import type { Usage } from '@earendil-works/pi-ai';
import { defineDoc } from '@earendil-works/pi-durable';
import type { Harness, ModelRef } from '@earendil-works/pi-durable';
import { localDay } from '../memory/util.ts';
import type { UsageReport, UsageRow } from '../protocol/session.ts';

/**
 * The usage report (ADR 0039): tokens and catalog cost per model, today, over the last 7 days, and all time.
 *
 * pi-durable keeps totals only (`harness.usage()`: every conversation's `pi.usage` summed, Pi's and the agents'), so
 * the host samples them into daily buckets: each sample adds what the totals grew by since the last one to the host's
 * local day. The memory's compactions call their model outside pi-durable; their spend arrives through `add()`, joins
 * the day it is sampled on, and is kept in `extra`, so "all time" is the SDK's totals plus `extra`. Tool results that
 * report usage (`pi.usage.tools`) name no model and are left out; none of this host's tools reports any.
 */

/** Persisted name (ADR 0039): never rename. */
export const USAGE_KIND = 'host.usage';
/** Days kept besides today: enough for two months of history, in a document that stays small. */
export const KEEP_DAYS = 62;
/** How often a running host samples. */
export const SAMPLE_MS = 300_000;

/** One model's spend: tokens by kind, and their cost at catalog prices. */
export type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
/** Spend by model, keyed `provider/model`. */
export type Totals = Record<string, Counts>;
export type HostUsage = {
  /** When the first sample ran (ms since the epoch), 0 before it: spend before it is in no day. */
  since: number;
  /** The SDK's totals at the last sample. */
  last: Totals;
  /** Spend per local day `YYYY-MM-DD` of the host, today and the KEEP_DAYS before it. */
  days: Record<string, Totals>;
  /** All-time compaction spend, which the SDK's totals lack. */
  extra: Totals;
};

const initial = (): HostUsage => ({ since: 0, last: {}, days: {}, extra: {} });

/** Session-wide daily buckets of the spend. */
export const HostUsageDoc = defineDoc<HostUsage>({
  kind: USAGE_KIND,
  version: 1,
  scope: 'session',
  initial,
  // A sample that finds new spend writes a delta: a base now and then keeps a reopen short.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const;
const ZERO: Readonly<Counts> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const spent = (counts: Readonly<Counts>): boolean => FIELDS.some(field => counts[field] > 0);
const tokens = (counts: Readonly<Counts>): number => counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
const plus = (a: Readonly<Counts> = ZERO, b: Readonly<Counts>): Counts => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
  cost: a.cost + b.cost,
});
/** What `total` grew by since `last`, never negative. */
const grown = (total: Readonly<Counts>, last: Readonly<Counts> = ZERO): Counts => ({
  input: Math.max(0, total.input - last.input), output: Math.max(0, total.output - last.output),
  cacheRead: Math.max(0, total.cacheRead - last.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - last.cacheWrite),
  cost: Math.max(0, total.cost - last.cost),
});
/** The local day `back` days before the day of `now`, as a `days` key. */
const dayBefore = (now: number, back: number): string => {
  const date = new Date(now);
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - back));
};

/** A pi-ai usage as counts: its cost is the catalog total. */
export function countsOf(usage: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> & { readonly cost: { readonly total: number } }): Counts {
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total };
}

/**
 * Apply one sample to `state`, in place, and say whether it changed anything. `pending` (compaction spend since the
 * last sample) joins `extra`; what `totals` (the SDK's, all time) grew by since the last sample, and `pending`, join
 * the local day of `now`; days older than KEEP_DAYS go. The first sample only records `totals`: they were spent before
 * counting began. `state` may be a commit's draft: every value is assigned whole and read back through `state`.
 */
export function applySample(state: HostUsage, totals: Readonly<Totals>, pending: Readonly<Totals>, now: number): boolean {
  const first = state.since === 0;
  let changed = first;
  if (first) state.since = now;
  const day = dayBefore(now, 0);
  const spend = (model: string, counts: Counts): void => {
    if (!spent(counts)) return;
    const today = state.days[day];
    if (today) today[model] = plus(today[model], counts);
    else state.days[day] = { [model]: counts };
    changed = true;
  };
  for (const [model, counts] of Object.entries(pending)) {
    if (!spent(counts)) continue;
    state.extra[model] = plus(state.extra[model], counts);
    spend(model, { ...counts });
  }
  for (const [model, total] of Object.entries(totals)) {
    const last = state.last[model];
    if (last && FIELDS.every(field => last[field] === total[field])) continue;
    if (!first) spend(model, grown(total, last));
    state.last[model] = { ...total };
    changed = true;
  }
  const oldest = dayBefore(now, KEEP_DAYS);
  for (const key of Object.keys(state.days)) {
    if (key >= oldest) continue;
    delete state.days[key];
    changed = true;
  }
  return changed;
}

/** Rows of `totals`, the most tokens first; models that spent nothing are left out. */
function rows(totals: Readonly<Totals>): UsageRow[] {
  return Object.entries(totals).filter(([, counts]) => spent(counts))
    .sort(([a, x], [b, y]) => tokens(y) - tokens(x) || a.localeCompare(b))
    .map(([model, counts]) => ({ model, ...counts }));
}

/**
 * The report at `now` from the stored buckets and the SDK's all-time `totals`: today and the last 7 local days from
 * `state.days`, all time as `totals` plus `state.extra`. Spend not sampled yet shows only in all time.
 */
export function usageReport(state: Readonly<HostUsage>, totals: Readonly<Totals>, now: number): UsageReport {
  const over = (days: number): UsageRow[] => {
    const sum: Totals = {};
    for (let back = 0; back < days; back++) {
      for (const [model, counts] of Object.entries(state.days[dayBefore(now, back)] ?? {})) sum[model] = plus(sum[model], counts);
    }
    return rows(sum);
  };
  const all: Totals = { ...totals };
  for (const [model, counts] of Object.entries(state.extra)) all[model] = plus(all[model], counts);
  return { today: over(1), week: over(7), all: rows(all), ...state.since ? { since: state.since } : {} };
}

/** What a tracker reads and writes: a Harness. */
export type UsageSource = Pick<Harness, 'usage' | 'snapshot' | 'commit'>;

/** Options of `createUsageTracker()`. */
export interface UsageTrackerOptions {
  /** The open Harness. A getter, since the memory, whose compactions `add()` counts, opens before it. */
  readonly harness: () => UsageSource | undefined;
  readonly context: Context;
  /** The host's clock, ms since the epoch: its local day is the bucket a sample fills. */
  readonly clock: () => number;
  /** false on an inspection: nothing is written, and a report is the stored days with the current totals. Default true. */
  readonly write?: boolean;
}

/** The host's usage counting: the sink for compaction spend, the sampler, and the report. */
export interface UsageTracker {
  /** Count one model call pi-durable does not see (a compaction). Held in memory until the next sample stores it. */
  add(model: ModelRef, usage: Usage): void;
  /** Store what was spent since the last sample, in one commit; none when nothing was. Samples run one at a time. */
  sample(): Promise<void>;
  /** The report as of now, after a sample of its own; without `write`, from what is stored. */
  report(): Promise<UsageReport>;
}

/**
 * The usage tracker of one chat. `add()` works at once; `sample()` and `report()` need the Harness open, and reject
 * until it is.
 */
export function createUsageTracker({ harness, context, clock, write = true }: UsageTrackerOptions): UsageTracker {
  let pending: Totals = {};
  const run = async (): Promise<UsageReport> => {
    const source = harness();
    if (!source) throw new Error('Harness is not open');
    // The totals are read before the commit, never in it: a Session read inside a commit can deadlock.
    const totals: Totals = Object.fromEntries(Object.entries((await source.usage(context)).models).map(([model, usage]) => [model, countsOf(usage)]));
    const state = structuredClone(await source.snapshot(HostUsageDoc, context)) ?? initial();
    const now = clock();
    if (!write) return usageReport(state, totals, now);
    const taken = pending;
    pending = {};
    // Tried on a copy first: an idle host's sample changes nothing, and then commits nothing.
    if (applySample(state, totals, taken, now)) {
      try {
        await source.commit(async (tx) => { applySample(await tx.doc(HostUsageDoc), totals, taken, now); }, context);
      } catch (error) {
        for (const [model, counts] of Object.entries(taken)) pending[model] = plus(pending[model], counts);
        throw error;
      }
    }
    return usageReport(state, totals, now);
  };
  // One at a time: a sample that stored older totals after a newer one's would count the growth between them twice.
  let last: Promise<unknown> = Promise.resolve();
  const next = (): Promise<UsageReport> => {
    const result = last.then(run);
    last = result.catch(() => undefined);
    return result;
  };
  return {
    add(model, usage) {
      const key = `${model.provider}/${model.modelId}`;
      pending[key] = plus(pending[key], countsOf(usage));
    },
    async sample() { await next(); },
    report: next,
  };
}
