import {
  MISS,
  emptyKeyStats,
  type CacheEntry,
  type CacheSource,
  type CacheStats,
  type KeyStats,
  type Loader,
  type LoaderResult,
  type LookupResult,
} from "./types.js";
import { MemoryL1Store, MemoryL2Store, type L1Store, type L2Store } from "./stores.js";
import type { InvalidationEvent, InvalidationTransport } from "./invalidation.js";

export interface MultiLevelCacheOptions<K, V> {
  /** Source-of-truth loader. Return `MISS` to populate the negative cache. */
  loader: Loader<K, V>;
  /** Positive-entry lifetime in milliseconds. */
  ttlMs: number;
  /** Negative-entry lifetime. Defaults to `ttlMs`. */
  negativeTtlMs?: number;
  /** Fractional TTL jitter in [0, 1]. 0.2 means +/-20%. */
  ttlJitter?: number;
  now?: () => number;
  random?: () => number;
  l1?: L1Store<K, V>;
  l2?: L2Store<K, V>;
  invalidation?: InvalidationTransport<K>;
  /** Unique identity for this cache instance's invalidation events. */
  origin?: string;
  onL2Error?: (error: unknown) => void;
  onInvalidationError?: (error: unknown, event: InvalidationEvent<K>) => void;
}

interface Flight<V> {
  readonly generation: number;
  readonly promise: Promise<CacheEntry<V>>;
}

interface InvalidationBarrier {
  readonly promise: Promise<void>;
  release(): void;
}

function defaultOrigin(): string {
  const cryptoObject = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  if (cryptoObject?.randomUUID) {
    return cryptoObject.randomUUID();
  }
  return `cache-${Math.random().toString(36).slice(2)}`;
}

function cloneStats(stats: KeyStats): CacheStats {
  return { ...stats };
}

/**
 * Two-level cache with single-flight loading, independent positive/negative
 * TTLs, deterministic TTL jitter and ordered, key-scoped invalidation.
 *
 * Every cache instance owns a monotonically increasing generation per key.
 * A load records the generation it started in and is only allowed to write
 * back while that generation is current. An invalidation detaches any
 * in-flight load, so old waiters still receive the same result but cannot
 * repopulate the cache after the invalidation. New requests immediately after
 * the invalidation form a fresh single-flight group.
 */
export class MultiLevelCache<K, V> {
  private readonly loader: Loader<K, V>;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly ttlJitter: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly l1: L1Store<K, V>;
  private readonly l2: L2Store<K, V> | undefined;
  private readonly invalidation: InvalidationTransport<K> | undefined;
  private readonly onL2Error: ((error: unknown) => void) | undefined;
  private readonly onInvalidationError:
    | ((error: unknown, event: InvalidationEvent<K>) => void)
    | undefined;
  private readonly origin: string;
  private readonly unsubscribe: (() => void) | undefined = undefined;

  private readonly generations = new Map<K, number>();
  private readonly localVersions = new Map<K, number>();
  private readonly remoteVersions = new Map<string, Map<K, number>>();
  private readonly flights = new Map<K, Flight<V>>();
  private readonly keyLocks = new Map<K, Promise<void>>();
  private readonly invalidationBarriers = new Map<K, Promise<void>>();
  private readonly perKeyStats = new Map<K, KeyStats>();
  private readonly totalStats: KeyStats = emptyKeyStats();

  private invalidationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: MultiLevelCacheOptions<K, V>) {
    if (typeof options.loader !== "function") {
      throw new TypeError("loader must be a function");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError("ttlMs must be a finite, non-negative number");
    }
    const negativeTtlMs = options.negativeTtlMs ?? options.ttlMs;
    if (!Number.isFinite(negativeTtlMs) || negativeTtlMs < 0) {
      throw new RangeError("negativeTtlMs must be a finite, non-negative number");
    }
    const ttlJitter = options.ttlJitter ?? 0;
    if (!Number.isFinite(ttlJitter) || ttlJitter < 0 || ttlJitter > 1) {
      throw new RangeError("ttlJitter must be in [0, 1]");
    }

    this.loader = options.loader;
    this.ttlMs = options.ttlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.ttlJitter = ttlJitter;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.l1 = options.l1 ?? new MemoryL1Store<K, V>();
    this.l2 = options.l2 ?? new MemoryL2Store<K, V>();
    this.invalidation = options.invalidation;
    this.onL2Error = options.onL2Error;
    this.onInvalidationError = options.onInvalidationError;
    this.origin = options.origin ?? defaultOrigin();

    if (this.invalidation) {
      this.unsubscribe = this.invalidation.subscribe((event) => {
        return this.applyInvalidation(event);
      });
    }
  }

  /** Returns the value, or `undefined` for a cached/loaded miss. */
  async get(key: K): Promise<V | undefined> {
    return (await this.getDetailed(key)).value;
  }

  /**
   * Like `get`, but also reports whether the result was negative and which
   * level (or the loader/single-flight group) served it.
   */
  async getDetailed(key: K): Promise<LookupResult<V>> {
    this.assertOpen();
    await this.awaitInvalidation(key);

    const l1Entry = this.l1.get(key);
    if (l1Entry !== undefined && this.isFresh(l1Entry)) {
      this.record(key, "l1Hits");
      if (l1Entry.kind === "negative") {
        this.record(key, "negativeHits");
      }
      return this.asLookup(l1Entry, "l1");
    }
    if (l1Entry !== undefined) {
      this.l1.delete(key);
    }

    const readGeneration = this.generationOf(key);
    const l2Entry = await this.readL2(key);
    if (l2Entry !== undefined && this.generationOf(key) === readGeneration) {
      if (this.isFresh(l2Entry)) {
        this.l1.set(key, l2Entry);
        this.record(key, "l2Hits");
        if (l2Entry.kind === "negative") {
          this.record(key, "negativeHits");
        }
        return this.asLookup(l2Entry, "l2");
      }
      await this.removeStaleL2(key);
    }

    // A concurrent flight may have filled L1 while this request was awaiting
    // L2. In that case the new entry is authoritative.
    const promoted = this.l1.get(key);
    if (promoted !== undefined && this.isFresh(promoted)) {
      this.record(key, "l1Hits");
      if (promoted.kind === "negative") {
        this.record(key, "negativeHits");
      }
      return this.asLookup(promoted, "l1");
    }

    // An invalidation may have raced with the L2 read above. Wait for its L2
    // delete before starting a new generation's flight, otherwise that flight
    // could write and then be erased by the older queued delete.
    await this.awaitInvalidation(key);
    this.record(key, "misses");
    const generation = this.generationOf(key);
    const existing = this.flights.get(key);
    if (existing !== undefined && existing.generation === generation) {
      this.record(key, "coalesced");
      const entry = await existing.promise;
      return this.asLookup(entry, "single-flight");
    }
    if (existing !== undefined) {
      this.flights.delete(key);
    }

    const flight = this.startFlight(key, generation);
    const entry = await flight.promise;
    return this.asLookup(entry, "loader");
  }

  /**
   * Invalidates one exact key in L1 and L2 and broadcasts the event. Multiple
   * calls are serialized so subscribers observe them in call order.
   */
  invalidate(key: K): Promise<void> {
    this.assertOpen();
    this.bumpGeneration(key);
    this.l1.delete(key);
    this.flights.delete(key);
    this.record(key, "invalidations");

    const version = (this.localVersions.get(key) ?? 0) + 1;
    this.localVersions.set(key, version);
    const event: InvalidationEvent<K> = {
      key,
      version,
      origin: this.origin,
    };

    const barrier = this.armInvalidationBarrier(key);
    return this.enqueueInvalidation(event, async () => {
      try {
        await this.withKeyLock(key, () => this.deleteL2(key));
      } finally {
        this.releaseInvalidationBarrier(key, barrier);
      }
      if (this.invalidation !== undefined) {
        await this.invalidation.publish(event);
      }
    });
  }

  /** Invalidates keys sequentially, preserving the supplied order. */
  async invalidateMany(keys: Iterable<K>): Promise<void> {
    for (const key of keys) {
      await this.invalidate(key);
    }
  }

  /**
   * Applies an event received from a transport. Own events and duplicate or
   * out-of-order events from a remote origin are ignored.
   */
  applyInvalidation(event: InvalidationEvent<K>): Promise<void> {
    if (this.closed || event.origin === this.origin) {
      return Promise.resolve();
    }
    if (!Number.isFinite(event.version)) {
      return Promise.resolve();
    }

    let versions = this.remoteVersions.get(event.origin);
    if (versions === undefined) {
      versions = new Map<K, number>();
      this.remoteVersions.set(event.origin, versions);
    }
    const previous = versions.get(event.key) ?? Number.NEGATIVE_INFINITY;
    if (event.version <= previous) {
      return Promise.resolve();
    }
    versions.set(event.key, event.version);

    this.bumpGeneration(event.key);
    this.l1.delete(event.key);
    this.flights.delete(event.key);
    this.record(event.key, "invalidations");

    const barrier = this.armInvalidationBarrier(event.key);
    return this.enqueueInvalidation(event, async () => {
      try {
        await this.withKeyLock(event.key, () => this.deleteL2(event.key));
      } finally {
        this.releaseInvalidationBarrier(event.key, barrier);
      }
    });
  }

  /** Reads a fresh entry without loading or promoting it. */
  async peek(key: K): Promise<CacheEntry<V> | undefined> {
    await this.awaitInvalidation(key);
    const l1Entry = this.l1.get(key);
    if (l1Entry !== undefined && this.isFresh(l1Entry)) {
      return l1Entry;
    }
    const l2Entry = await this.readL2(key);
    if (l2Entry !== undefined && this.isFresh(l2Entry)) {
      return l2Entry;
    }
    return undefined;
  }

  stats(): CacheStats {
    return cloneStats(this.totalStats);
  }

  statsFor(key: K): CacheStats {
    return cloneStats(this.perKeyStats.get(key) ?? emptyKeyStats());
  }

  resetStats(): void {
    Object.assign(this.totalStats, emptyKeyStats());
    this.perKeyStats.clear();
  }

  /**
   * Stops accepting work and detaches from the invalidation transport.
   * In-flight loads are allowed to settle, but their late writes are fenced
   * off by the per-key generation.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe?.();
    for (const key of [...this.flights.keys()]) {
      this.flights.delete(key);
      this.bumpGeneration(key);
    }
    await this.invalidationTail;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("cache is closed");
    }
  }

  private startFlight(key: K, generation: number): Flight<V> {
    const promise = this.runLoad(key, generation);
    const flight: Flight<V> = { generation, promise };
    this.flights.set(key, flight);
    const cleanup = (): void => {
      if (this.flights.get(key) === flight) {
        this.flights.delete(key);
      }
    };
    void promise.then(cleanup, cleanup);
    return flight;
  }

  private async runLoad(key: K, generation: number): Promise<CacheEntry<V>> {
    this.record(key, "loads");
    let loaded: LoaderResult<V>;
    try {
      loaded = await this.loader(key);
    } catch (error) {
      this.record(key, "loadFailures");
      throw error;
    }

    const entry: CacheEntry<V> =
      loaded === MISS
        ? {
            kind: "negative",
            expiresAt: this.now() + this.jitteredTtl(this.negativeTtlMs),
          }
        : {
            kind: "value",
            value: loaded as V,
            expiresAt: this.now() + this.jitteredTtl(this.ttlMs),
          };

    await this.commit(key, generation, entry);
    return entry;
  }

  /**
   * Writes L2 first, then L1. The generation is checked before and after each
   * write; if an invalidation won the race, any partial write is removed.
   */
  private async commit(key: K, generation: number, entry: CacheEntry<V>): Promise<boolean> {
    return this.withKeyLock(key, async () => {
      if (this.generationOf(key) !== generation) {
        this.record(key, "staleWritesRejected");
        return false;
      }

      let wroteL2 = false;
      if (this.l2 !== undefined) {
        try {
          await this.l2.set(key, entry);
          wroteL2 = true;
        } catch (error) {
          this.onL2Error?.(error);
        }
      }

      if (this.generationOf(key) !== generation) {
        this.record(key, "staleWritesRejected");
        this.l1.delete(key);
        if (wroteL2) {
          await this.deleteL2(key);
        }
        return false;
      }

      this.l1.set(key, entry);

      // Invalidation may have deleted L1 while the L2 write was awaited.
      // Check once more so the failed generation cannot leave data behind.
      if (this.generationOf(key) !== generation) {
        this.record(key, "staleWritesRejected");
        this.l1.delete(key);
        if (wroteL2) {
          await this.deleteL2(key);
        }
        return false;
      }
      return true;
    });
  }

  private enqueueInvalidation(
    event: InvalidationEvent<K>,
    work: () => Promise<void>,
  ): Promise<void> {
    const task = this.invalidationTail.then(work, work);
    this.invalidationTail = task.then(
      () => undefined,
      (error: unknown) => {
        this.onInvalidationError?.(error, event);
      },
    );
    return task;
  }

  private async readL2(key: K): Promise<CacheEntry<V> | undefined> {
    if (this.l2 === undefined) {
      return undefined;
    }
    try {
      return await this.l2.get(key);
    } catch (error) {
      this.onL2Error?.(error);
      return undefined;
    }
  }

  private async deleteL2(key: K): Promise<void> {
    if (this.l2 === undefined) {
      return;
    }
    try {
      await this.l2.delete(key);
    } catch (error) {
      this.onL2Error?.(error);
    }
  }

  /**
   * Deletes an expired L2 entry under the per-key lock, but only if it is
   * still the expired entry. A concurrent loader may have replaced it with a
   * fresh value while this request was awaiting the lock.
   */
  private async removeStaleL2(key: K): Promise<void> {
    await this.withKeyLock(key, async () => {
      const current = await this.readL2(key);
      if (current !== undefined && !this.isFresh(current)) {
        await this.deleteL2(key);
      }
    });
  }

  private async withKeyLock<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => gate,
      () => gate,
    );
    this.keyLocks.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.keyLocks.get(key) === queued) {
        this.keyLocks.delete(key);
      }
    }
  }

  private armInvalidationBarrier(key: K): InvalidationBarrier {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.invalidationBarriers.set(key, barrier);
    return {
      promise: barrier,
      release: () => release(),
    };
  }

  private releaseInvalidationBarrier(key: K, barrier: InvalidationBarrier): void {
    barrier.release();
    if (this.invalidationBarriers.get(key) === barrier.promise) {
      this.invalidationBarriers.delete(key);
    }
  }

  private async awaitInvalidation(key: K): Promise<void> {
    for (;;) {
      const barrier = this.invalidationBarriers.get(key);
      if (barrier === undefined) {
        return;
      }
      await barrier;
      if (this.invalidationBarriers.get(key) === barrier) {
        this.invalidationBarriers.delete(key);
        return;
      }
    }
  }

  private isFresh(entry: CacheEntry<V>): boolean {
    return entry.expiresAt > this.now();
  }

  private jitteredTtl(baseTtlMs: number): number {
    if (baseTtlMs <= 0 || this.ttlJitter === 0) {
      return baseTtlMs;
    }
    let sample = this.random();
    if (!Number.isFinite(sample)) {
      sample = 0.5;
    }
    sample = Math.min(1, Math.max(0, sample));
    return baseTtlMs * (1 + this.ttlJitter * (2 * sample - 1));
  }

  private asLookup(entry: CacheEntry<V>, source: CacheSource): LookupResult<V> {
    if (entry.kind === "negative") {
      return {
        value: undefined,
        negative: true,
        source,
        expiresAt: entry.expiresAt,
      };
    }
    return {
      value: entry.value,
      negative: false,
      source,
      expiresAt: entry.expiresAt,
    };
  }

  private generationOf(key: K): number {
    return this.generations.get(key) ?? 0;
  }

  private bumpGeneration(key: K): void {
    this.generations.set(key, this.generationOf(key) + 1);
  }

  private record(key: K, field: keyof KeyStats): void {
    this.totalStats[field] += 1;
    let stats = this.perKeyStats.get(key);
    if (stats === undefined) {
      stats = emptyKeyStats();
      this.perKeyStats.set(key, stats);
    }
    stats[field] += 1;
  }
}
