import type { CacheEntry } from "./types.js";

export interface L2Store<K, V> {
  get(key: K): Promise<CacheEntry<V> | undefined> | CacheEntry<V> | undefined;
  set(key: K, entry: CacheEntry<V>): Promise<void> | void;
  delete(key: K): Promise<void> | void;
}

export interface L1Store<K, V> {
  get(key: K): CacheEntry<V> | undefined;
  set(key: K, entry: CacheEntry<V>): void;
  delete(key: K): void;
  clear(): void;
}

export class MemoryL1Store<K, V> implements L1Store<K, V> {
  private entries = new Map<K, CacheEntry<V>>();

  get(key: K): CacheEntry<V> | undefined {
    return this.entries.get(key);
  }

  set(key: K, entry: CacheEntry<V>): void {
    this.entries.set(key, entry);
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * A tiny reference L2. Real deployments can plug Redis/Memcached/etc. behind
 * the same interface.
 */
export class MemoryL2Store<K, V> implements L2Store<K, V> {
  private entries = new Map<K, CacheEntry<V>>();
  private setCounts = new Map<K, number>();

  get(key: K): CacheEntry<V> | undefined {
    return this.entries.get(key);
  }

  set(key: K, entry: CacheEntry<V>): void {
    this.entries.set(key, entry);
    this.setCounts.set(key, (this.setCounts.get(key) ?? 0) + 1);
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.setCounts.clear();
  }

  /** Number of successful writes for a key, including overwrites. */
  writesFor(key: K): number {
    return this.setCounts.get(key) ?? 0;
  }

  size(): number {
    return this.entries.size;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }
}
