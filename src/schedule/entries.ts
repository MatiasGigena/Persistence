// The entry a scheduled wake-up reaches Pi as (src/schedule/index.ts places it): its persisted kind and the one decoder
// of its data. Nothing here loads pi-durable, so the memory, the feed and the terminal host read it cheaply.
import { isRecord } from '../protocol/util.ts';

/** The entry kind of a wake-up; persisted in every chat, so frozen. */
export const FIRE_KIND = 'schedule.fire';

/** A wake-up, decoded: schedule `id`, the text Pi wrote for itself, and when it was due (ms since the epoch). */
export interface ScheduleFire {
  readonly id: number;
  readonly text: string;
  readonly due: number;
  /** The expression of a repeating schedule. */
  readonly cron?: string;
}

/** The wake-up an entry carries, or undefined for any other entry or for data of the wrong shape. */
export function scheduleFireOf(entry: { readonly kind: string; readonly data?: unknown }): ScheduleFire | undefined {
  const { data } = entry;
  if (entry.kind !== FIRE_KIND || !isRecord(data)) return undefined;
  if (typeof data.id !== 'number' || typeof data.text !== 'string' || typeof data.due !== 'number') return undefined;
  return { id: data.id, text: data.text, due: data.due, ...typeof data.cron === 'string' ? { cron: data.cron } : {} };
}

/**
 * Who a wake-up is from, as chat items and the memory name it: `Schedule #3`. Never an agent's name (those hold no
 * space or `#`), so it cannot be taken for an agent's report.
 */
export const fireName = (id: number): string => `Schedule #${id}`;
