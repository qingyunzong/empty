import type { CacheEntry, CacheSource } from "../src/types.js";

export interface ModelLookup<V> {
  readonly value: V | undefined;
  readonly negative: boolean;
  readonly source: CacheSource;
}

export interface ModelOptions {
  ttlMs: number;
  negativeTtlMs: number;
  now: () => number;
}

interface ModelFlight<K, V> {
  readonly key: K;
  readonly id: number;
  readonly generation: number;
  readonly promise: Promise<ModelLookup<V>>;
  readonly resolve: (result: ModelLookup<V>) => void;
  settled: boolean;
}

/**
 * Deliberately small, synchronous model of the cache contract. It has no
 * async plumbing: the test harness only advances it at points where every
 * real cache operation has reached a stable microtask boundary.
 */
export class NaiveCacheModel<K, V> {
  readonly l1 = new Map<K, CacheEntry<V>>();
  readonly l2 = new Map<K, CacheEntry<V>>();

  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly generations = new Map<K, number>();
  private readonly activeFlights = new Map<K, ModelFlight<K, V>>();
  private readonly pendingFlights: ModelFlight<K, V>[] = [];
  private readonly loadCalls = new Map<K, number>();
  private readonly writeCalls = new Map<K, number>();

  constructor(options: ModelOptions) {
    this.ttlMs = options.ttlMs;
    this.negativeTtlMs = options.negativeTtlMs;
    this.now = options.now;
  }

  beginGet(key: K): Promise<ModelLookup<V>> {
    const l1Entry = this.l1.get(key);
    if (l1Entry !== undefined && this.isFresh(l1Entry)) {
      return Promise.resolve(this.lookup(l1Entry, "l1"));
    }
    if (l1Entry !== undefined) {
      this.l1.delete(key);
    }

    const l2Entry = this.l2.get(key);
    if (l2Entry !== undefined) {
      if (this.isFresh(l2Entry)) {
        this.l1.set(key, l2Entry);
        return Promise.resolve(this.lookup(l2Entry, "l2"));
      }
      this.l2.delete(key);
    }

    const generation = this.generationOf(key);
    const active = this.activeFlights.get(key);
    if (active !== undefined && active.generation === generation) {
      return active.promise.then((result) => ({
        ...result,
        source: "single-flight",
      }));
    }

    const id = (this.loadCalls.get(key) ?? 0) + 1;
    this.loadCalls.set(key, id);
    let resolve!: (result: ModelLookup<V>) => void;
    const promise = new Promise<ModelLookup<V>>((fulfil) => {
      resolve = fulfil;
    });
    const flight: ModelFlight<K, V> = {
      key,
      id,
      generation,
      promise,
      resolve,
      settled: false,
    };
    this.activeFlights.set(key, flight);
    this.pendingFlights.push(flight);
    return promise;
  }

  completeLoads(key: K, found: boolean): number {
    let completed = 0;
    for (let index = this.pendingFlights.length - 1; index >= 0; index -= 1) {
      const flight = this.pendingFlights[index];
      if (!Object.is(flight.key, key)) {
        continue;
      }
      this.pendingFlights.splice(index, 1);
      if (flight.settled) {
        continue;
      }
      flight.settled = true;
      completed += 1;

      const entry: CacheEntry<V> = found
        ? {
            kind: "value",
            value: `${String(key)}#${flight.id}` as V,
            expiresAt: this.now() + this.ttlMs,
          }
        : {
            kind: "negative",
            expiresAt: this.now() + this.negativeTtlMs,
          };

      if (this.generationOf(key) === flight.generation) {
        this.l2.set(key, entry);
        this.writeCalls.set(key, (this.writeCalls.get(key) ?? 0) + 1);
        this.l1.set(key, entry);
      }

      if (this.activeFlights.get(key) === flight) {
        this.activeFlights.delete(key);
      }
      flight.resolve(this.lookup(entry, "loader"));
    }
    return completed;
  }

  invalidate(key: K): void {
    this.generations.set(key, this.generationOf(key) + 1);
    this.l1.delete(key);
    this.l2.delete(key);
    this.activeFlights.delete(key);
  }

  pendingCount(key: K): number {
    return this.pendingFlights.filter((flight) => Object.is(flight.key, key)).length;
  }

  loadsFor(key: K): number {
    return this.loadCalls.get(key) ?? 0;
  }

  writesFor(key: K): number {
    return this.writeCalls.get(key) ?? 0;
  }

  private generationOf(key: K): number {
    return this.generations.get(key) ?? 0;
  }

  private isFresh(entry: CacheEntry<V>): boolean {
    return entry.expiresAt > this.now();
  }

  private lookup(entry: CacheEntry<V>, source: CacheSource): ModelLookup<V> {
    return entry.kind === "negative"
      ? { value: undefined, negative: true, source }
      : { value: entry.value, negative: false, source };
  }
}
