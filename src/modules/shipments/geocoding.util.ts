/**
 * Small helpers shared by the shipment and driver services for outbound
 * geocoding calls: a bounded TTL cache (so failures are not cached forever and
 * memory cannot grow without limit) and the default timeouts/TTLs.
 */

export const GEOCODE_FETCH_TIMEOUT_MS = 5_000;
export const GEOCODE_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const GEOCODE_NEGATIVE_TTL_MS = 5 * 60 * 1000;
export const GEOCODE_CACHE_MAX_ENTRIES = 1000;

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

/**
 * Map-backed cache with a per-entry TTL and a maximum size. Reads refresh the
 * entry's recency (delete + re-insert), and inserts evict the least recently
 * used entries once the size limit is reached.
 */
export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(private readonly maxEntries = GEOCODE_CACHE_MAX_ENTRIES) {}

  /** Returns `{ value }` for a live entry, or `undefined` when missing/expired. */
  lookup(key: string): { value: V } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value };
  }

  set(key: string, value: V, ttlMs: number) {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const [oldestKey] = this.entries.keys();
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }

  /** Caches a geocode result: successes for a day, misses/failures for 5 minutes. */
  setResult(key: string, value: V) {
    this.set(
      key,
      value,
      value === null || value === undefined
        ? GEOCODE_NEGATIVE_TTL_MS
        : GEOCODE_POSITIVE_TTL_MS,
    );
  }
}
