// Five-field cron expressions (minute hour day-of-month month day-of-week) in the host's local time, for repeating
// schedules (ADR 0038). No imports: plain date arithmetic, so the tests run it on fixed dates.

/** A parsed expression: the values each field takes, and whether the two day fields were restricted. */
export interface Cron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Vixie cron's rule: with both day fields restricted a day matches either; else it must match both. */
  readonly eitherDay: boolean;
}

/** Why an expression does not parse; its message is shown to the model, so it says what to write instead. */
export class CronError extends Error {
  override readonly name = 'CronError';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** How far ahead `nextAfter` looks: an expression with no day in five years (`0 0 30 2 *`) never fires. */
const HORIZON_MS = 5 * 366 * 86_400_000;

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** Names for the values from `min` on (months, weekdays). */
  readonly names?: readonly string[];
}

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  // 7 is Sunday too, as in every cron.
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS },
];

/** One value of a field: a number in its range, or one of its names. */
function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  const number = named >= 0 ? named + field.min : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(number) || number < field.min || number > field.max) {
    throw new CronError(`${field.name} ${JSON.stringify(text)} is not ${field.min} to ${field.max}`);
  }
  return number;
}

/** The values of one field: `*`, `a`, `a-b`, each with an optional `/step`, joined by commas. */
function values(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', step, ...rest] = part.split('/');
    if (rest.length || !range) throw new CronError(`${field.name} ${JSON.stringify(part)} is not a value, a range or a step`);
    const every = step === undefined ? 1 : /^\d+$/.test(step) ? Number(step) : 0;
    if (every < 1) throw new CronError(`${field.name} step ${JSON.stringify(step)} is not a positive number`);
    const [low = '', high, ...more] = range.split('-');
    if (more.length) throw new CronError(`${field.name} ${JSON.stringify(part)} is not a range`);
    const from = range === '*' ? field.min : value(low, field);
    // A single value with a step (`5/15`) runs to the field's end, as in Vixie cron.
    const to = range === '*' ? field.max : high === undefined ? (step === undefined ? from : field.max) : value(high, field);
    if (to < from) throw new CronError(`${field.name} range ${JSON.stringify(range)} runs backwards`);
    for (let each = from; each <= to; each += every) out.add(each);
  }
  return out;
}

/** Parse `expression`; throws a CronError that names the field at fault. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError('a cron expression has 5 fields: minute hour day-of-month month day-of-week, such as "0 9 * * 1-5"');
  }
  const [minutes, hours, days, months, weekdays] = FIELDS.map((field, index) => values(parts[index] ?? '', field));
  if (!minutes || !hours || !days || !months || !weekdays) throw new CronError('a cron expression has 5 fields');
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, eitherDay: parts[2] !== '*' && parts[4] !== '*' };
}

function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.days.has(date.getDate()), weekday = cron.weekdays.has(date.getDay());
  return cron.eitherDay ? day || weekday : day && weekday;
}

/**
 * The first minute after `after` (ms since the epoch) that `cron` matches in local time, or undefined when there is
 * none within five years. Always later than `after`. A local time a clock change skips is not matched that day; one it
 * repeats is matched once.
 */
export function nextAfter(cron: Cron, after: number): number | undefined {
  const limit = after + HORIZON_MS;
  // The start of the next minute.
  let at = Math.floor(after / 60_000) * 60_000 + 60_000;
  while (at <= limit) {
    const date = new Date(at);
    // Each jump is to a local boundary and always forward: a clock change can make the local constructor land early.
    const forward = (next: number, least: number): number => next > at ? next : at + least;
    if (!cron.months.has(date.getMonth() + 1)) {
      at = forward(new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(), 86_400_000);
    } else if (!dayMatches(cron, date)) {
      at = forward(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(), 3_600_000);
    } else if (!cron.hours.has(date.getHours())) {
      at += (60 - date.getMinutes()) * 60_000;
    } else if (!cron.minutes.has(date.getMinutes())) {
      at += 60_000;
    } else return at;
  }
  return undefined;
}

/** The shortest gap between the next `count` fires after `after`, in ms; undefined when it never fires twice. */
export function shortestGap(cron: Cron, after: number, count = 64): number | undefined {
  let shortest: number | undefined, last = nextAfter(cron, after);
  for (let n = 1; n < count && last !== undefined; n++) {
    const next = nextAfter(cron, last);
    if (next === undefined) break;
    shortest = Math.min(shortest ?? Infinity, next - last);
    last = next;
  }
  return shortest;
}
