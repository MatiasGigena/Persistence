import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CronError, nextAfter, parseCron, shortestGap } from '../../src/schedule/cron.ts';

/** A local time, so the tests hold in any zone. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
const next = (expression: string, after: number): number | undefined => nextAfter(parseCron(expression), after);

describe('cron expressions', () => {
  test('the next minute an expression matches, in local time, always later than the start', () => {
    // 2026-11-10 is a Tuesday.
    const tuesday = at(2026, 11, 10, 14, 3);
    assert.equal(next('0 9 * * *', tuesday), at(2026, 11, 11, 9));
    assert.equal(next('30 14 * * *', tuesday), at(2026, 11, 10, 14, 30));
    assert.equal(next('3 14 * * *', tuesday), at(2026, 11, 11, 14, 3), 'never the start itself');
    assert.equal(next('*/15 * * * *', tuesday), at(2026, 11, 10, 14, 15));
    assert.equal(next('0 9 * * 1-5', at(2026, 11, 13, 9)), at(2026, 11, 16, 9), 'Friday 9:00 to Monday');
    assert.equal(next('0 0 1 * *', tuesday), at(2026, 12, 1));
    assert.equal(next('0 8 1 1 *', tuesday), at(2027, 1, 1, 8));
    assert.equal(next('0 12 29 2 *', tuesday), at(2028, 2, 29, 12), 'a leap day');
    // Seconds inside a minute do not match again in it.
    assert.equal(next('* * * * *', tuesday + 59_000), tuesday + 60_000);
  });

  test('lists, ranges, steps and names', () => {
    const start = at(2026, 11, 10);
    assert.equal(next('5,35 3 * * *', start), at(2026, 11, 10, 3, 5));
    assert.equal(next('0 22-23 * * *', start), at(2026, 11, 10, 22));
    assert.equal(next('0 6-18/6 * * *', at(2026, 11, 10, 7)), at(2026, 11, 10, 12));
    assert.equal(next('20/20 * * * *', start), at(2026, 11, 10, 0, 20), 'a value with a step runs to the end of its field');
    assert.equal(next('0 9 * nov sat', start), at(2026, 11, 14, 9));
    assert.equal(next('0 9 * * 7', start), at(2026, 11, 15, 9), '7 is Sunday');
    assert.equal(next('0 9 * * 0', start), at(2026, 11, 15, 9));
    assert.equal(next('0 9 * JAN MON', start), at(2027, 1, 4, 9));
  });

  test('both day fields restricted: a day matches either, as in Vixie cron', () => {
    const start = at(2026, 11, 10);
    // The 13th, or any Friday: Friday the 13th of November 2026 comes first, then Friday the 20th.
    assert.equal(next('0 0 13 * 5', start), at(2026, 11, 13));
    assert.equal(next('0 0 13 * 5', at(2026, 11, 13)), at(2026, 11, 20));
    assert.equal(next('0 0 15 * 1', start), at(2026, 11, 15), 'the 15th, a Sunday');
    assert.equal(next('0 0 15 * 1', at(2026, 11, 15)), at(2026, 11, 16), 'then a Monday');
  });

  test('a local time a clock change repeats fires once', t => {
    const zone = process.env.TZ;
    t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
    process.env.TZ = 'America/New_York';
    // 2026-11-01 01:00 EDT falls back to 01:00 EST: 01:30 happens twice, at 05:30 and 06:30 UTC.
    const first = next('30 1 * * *', Date.parse('2026-10-31T12:00:00Z'));
    assert.equal(first, Date.parse('2026-11-01T05:30:00Z'));
    assert.equal(next('30 1 * * *', first ?? 0), Date.parse('2026-11-02T06:30:00Z'), 'the next day, not 01:30 EST');
  });

  test('an expression that never matches gives undefined', () => {
    assert.equal(next('0 0 30 2 *', at(2026, 1, 1)), undefined);
    assert.equal(next('0 0 31 4,6,9,11 *', at(2026, 1, 1)), undefined);
  });

  test('the shortest gap between fires', () => {
    const start = at(2026, 11, 10);
    assert.equal(shortestGap(parseCron('* * * * *'), start), 60_000);
    assert.equal(shortestGap(parseCron('*/5 * * * *'), start), 300_000);
    assert.equal(shortestGap(parseCron('0,2 9 * * *'), start), 120_000, 'two close minutes once a day');
    assert.equal(shortestGap(parseCron('59 * * * *'), start), 3_600_000);
    assert.equal(shortestGap(parseCron('0 0 30 2 *'), start), undefined);
  });

  test('a malformed expression names the field at fault', () => {
    const fails = (expression: string, pattern: RegExp): void => {
      assert.throws(() => parseCron(expression), (error: unknown) => error instanceof CronError && pattern.test(error.message), expression);
    };
    fails('0 9 * *', /5 fields/);
    fails('0 9 * * * *', /5 fields/);
    fails('60 9 * * *', /minute "60" is not 0 to 59/);
    fails('0 24 * * *', /hour "24"/);
    fails('0 9 0 * *', /day of month "0"/);
    fails('0 9 * 13 *', /month "13"/);
    fails('0 9 * * 8', /day of week "8"/);
    fails('0 9 * * funday', /day of week "funday"/);
    fails('*/0 9 * * *', /minute step "0"/);
    fails('5-1 9 * * *', /runs backwards/);
    fails('1-2-3 9 * * *', /not a range/);
    fails('0 9 * * 1,', /day of week/);
    fails('@daily', /5 fields/);
  });
});
