// The panels' lists, kept across openings and asked for at most once at a time: a panel shows what it last had at
// once while the fresh answer comes, and a background warm-up (chat-settings.ts `prefetchSettings`) and the panel
// itself share one request. DOM-free, so test/web runs it in Node.

/** Values by key, each loaded by at most one request at a time. */
export class Shared<V> {
  private readonly values = new Map<string, V>();
  private readonly flights = new Map<string, Promise<V>>();
  private last: V | undefined;

  /** The value last kept for `key`. */
  get(key: string): V | undefined { return this.values.get(key); }

  /** The value last kept for any key. */
  get latest(): V | undefined { return this.last; }

  /** Whether a load of `key` is in flight. */
  loading(key: string): boolean { return this.flights.has(key); }

  /**
   * Loads `key` by `fetch`, or joins the load of it already in flight (whoever started it). The answer is kept when
   * `keep`, asked as it comes, allows; a failure keeps what was there and rejects every caller that joined.
   */
  load(key: string, fetch: () => Promise<V>, keep: () => boolean = () => true): Promise<V> {
    const flying = this.flights.get(key);
    if (flying) return flying;
    const flight = fetch().then(value => {
      if (keep()) {
        this.values.set(key, value);
        this.last = value;
      }
      return value;
    }).finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }
}
