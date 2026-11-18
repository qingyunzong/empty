/**
 * Sentinel returned by a loader when the source of truth has no value for a
 * key. Returning `MISS` (rather than `undefined`/`null`) keeps the loader
 * usable with value types that legitimately contain those values.
 */
export const MISS: unique symbol = Symbol.for("msp-cache.missing");

export type Missing = typeof MISS;
export type LoaderResult<V> = V | Missing;
export type Loader<K, V> = (key: K) => LoaderResult<V> | Promise<LoaderResult<V>>;

export type CacheSource = "l1" | "l2" | "loader" | "single-flight";

export interface ValueEntry<V> {
  readonly kind: "value";
  readonly value: V;
  readonly expiresAt: number;
}

export interface NegativeEntry {
  readonly kind: "negative";
  readonly expiresAt: number;
}

export type CacheEntry<V> = ValueEntry<V> | NegativeEntry;

export interface LookupResult<V> {
  /** Cached or loaded value. `undefined` for a negative entry. */
  readonly value: V | undefined;
  /** True when this result came from the negative cache. */
  readonly negative: boolean;
  readonly source: CacheSource;
  /** Absolute expiry timestamp of the returned entry. */
  readonly expiresAt: number;
}

export interface KeyStats {
  l1Hits: number;
  l2Hits: number;
  negativeHits: number;
  misses: number;
  loads: number;
  coalesced: number;
  invalidations: number;
  staleWritesRejected: number;
  loadFailures: number;
}

export type CacheStats = KeyStats;

export function emptyKeyStats(): KeyStats {
  return {
    l1Hits: 0,
    l2Hits: 0,
    negativeHits: 0,
    misses: 0,
    loads: 0,
    coalesced: 0,
    invalidations: 0,
    staleWritesRejected: 0,
    loadFailures: 0,
  };
}
