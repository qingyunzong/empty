export type Loader<K, V> = (key: K) => Promise<V>;

interface Entry<V> {
  readonly generation: number;
  readonly promise: Promise<V>;
}

/**
 * In-flight promise cache with LRU capacity eviction.
 *
 * Semantics:
 * - The cache stores *in-flight* promises produced by `loader`.
 * - While an entry is cached, requests for the same key share its promise.
 * - Once an entry is evicted (or settled), a request for the same key
 *   creates a brand-new task with a new generation.
 * - Eviction only detaches the entry from the cache; it never cancels the
 *   underlying promise, so existing waiters still receive their result.
 * - Settling (success or failure) removes the entry from the cache, but
 *   only if that exact generation is still the cached one. A late-settling
 *   promise from an evicted generation is never re-inserted.
 */
export class PromiseCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private nextGeneration = 0;

  constructor(
    private readonly capacity: number,
    private readonly loader: Loader<K, V>,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): Promise<V> {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // LRU touch: re-insert so this key becomes most-recently-used.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }

    const entry: Entry<V> = {
      generation: this.nextGeneration++,
      promise: this.startTask(key),
    };
    this.entries.set(key, entry);
    this.evictIfNeeded();

    entry.promise.then(
      () => this.release(key, entry),
      () => this.release(key, entry),
    );
    return entry.promise;
  }

  /** Starts the loader task; a synchronous throw becomes a rejection. */
  private startTask(key: K): Promise<V> {
    try {
      return Promise.resolve(this.loader(key));
    } catch (reason) {
      return Promise.reject(reason);
    }
  }

  /**
   * Removes the entry only when this exact generation is still cached.
   * Never inserts anything: a late result from an evicted generation
   * cannot put itself back into the cache.
   */
  private release(key: K, entry: Entry<V>): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      this.entries.delete(oldest.value as K);
    }
  }
}
