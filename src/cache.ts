const NS_SEP = "\x00";
const KEY_SEP = "\x01";

export type Loader<V> = () => Promise<V>;

export interface CacheEntry<V> {
  readonly tenant: string;
  readonly key: string;
  readonly generation: number;
  readonly value: V;
  readonly createdAt: number;
}

export interface CacheOptions {
  /** Maximum live entries per (tenant, generation) namespace; LRU beyond that. */
  maxEntriesPerNamespace?: number;
}

/**
 * Cache whose effective key is (tenant, generation, key).
 *
 * - A permission change (`setPermissions` / `revokePermissions`) atomically
 *   bumps the tenant generation, switching every subsequent lookup to a fresh
 *   namespace. The old namespace is dropped synchronously in the same call.
 * - A load started under generation N is never published into generation N+1:
 *   when the loader settles, the result is stored only if the generation is
 *   still the one the load started in.
 * - Waiters attached to an in-flight load keep the promise of the generation
 *   they attached to, so they always observe the original generation's result.
 */
export class TenantGenerationCache<V = unknown> {
  private readonly maxEntries: number;
  private readonly generationByTenant = new Map<string, number>();
  private readonly permissionsByTenant = new Map<string, ReadonlySet<string>>();
  private readonly namespaces = new Map<string, Map<string, CacheEntry<V>>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(options: CacheOptions = {}) {
    this.maxEntries = options.maxEntriesPerNamespace ?? 128;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntriesPerNamespace must be a positive integer");
    }
  }

  generationOf(tenant: string): number {
    return this.generationByTenant.get(tenant) ?? 0;
  }

  permissionsOf(tenant: string): ReadonlySet<string> | undefined {
    return this.permissionsByTenant.get(tenant);
  }

  /**
   * Atomically replace the tenant's permission set and switch namespace:
   * the generation bump, permission swap and old-namespace drop all happen
   * synchronously before this function returns.
   */
  setPermissions(tenant: string, permissions: Iterable<string>): number {
    this.permissionsByTenant.set(tenant, new Set(permissions));
    return this.switchNamespace(tenant);
  }

  /** Atomically revoke all permissions and switch namespace. */
  revokePermissions(tenant: string): number {
    this.permissionsByTenant.delete(tenant);
    return this.switchNamespace(tenant);
  }

  private switchNamespace(tenant: string): number {
    const previous = this.generationOf(tenant);
    const next = previous + 1;
    this.generationByTenant.set(tenant, next);
    this.namespaces.delete(this.namespace(tenant, previous));
    return next;
  }

  get(tenant: string, key: string): V | undefined {
    return this.getEntry(tenant, key)?.value;
  }

  getEntry(tenant: string, key: string): CacheEntry<V> | undefined {
    const store = this.namespaces.get(this.currentNamespace(tenant));
    const entry = store?.get(key);
    if (entry && store) {
      // LRU refresh: reinsert at the tail.
      store.delete(key);
      store.set(key, entry);
    }
    return entry;
  }

  has(tenant: string, key: string): boolean {
    return this.getEntry(tenant, key) !== undefined;
  }

  /** Remove a single key from the tenant's current namespace. */
  evict(tenant: string, key: string): boolean {
    const store = this.namespaces.get(this.currentNamespace(tenant));
    return store?.delete(key) ?? false;
  }

  size(tenant: string): number {
    return this.namespaces.get(this.currentNamespace(tenant))?.size ?? 0;
  }

  /**
   * Return the cached value for the tenant's current generation, or join the
   * in-flight load for this generation, or start one.
   *
   * The returned promise always settles with the result of the load that was
   * in flight for the generation at call time, even if the namespace switches
   * before it settles. The value is only written back into the cache if the
   * generation is unchanged at settle time.
   */
  getOrLoad(tenant: string, key: string, loader: Loader<V>): Promise<V> {
    const generation = this.generationOf(tenant);
    const namespace = this.namespace(tenant, generation);

    const store = this.namespaces.get(namespace);
    const hit = store?.get(key);
    if (hit) {
      store!.delete(key);
      store!.set(key, hit);
      return Promise.resolve(hit.value);
    }

    const flightKey = namespace + KEY_SEP + key;
    const pending = this.inflight.get(flightKey);
    if (pending) {
      return pending;
    }

    const promise = (async (): Promise<V> => {
      try {
        const value = await loader();
        if (this.generationOf(tenant) === generation) {
          this.put(namespace, { tenant, key, generation, value, createdAt: Date.now() });
        }
        return value;
      } finally {
        this.inflight.delete(flightKey);
      }
    })();
    this.inflight.set(flightKey, promise);
    return promise;
  }

  private put(namespace: string, entry: CacheEntry<V>): void {
    let store = this.namespaces.get(namespace);
    if (!store) {
      store = new Map();
      this.namespaces.set(namespace, store);
    }
    store.delete(entry.key);
    store.set(entry.key, entry);
    while (store.size > this.maxEntries) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  private currentNamespace(tenant: string): string {
    return this.namespace(tenant, this.generationOf(tenant));
  }

  private namespace(tenant: string, generation: number): string {
    return tenant + NS_SEP + String(generation);
  }
}
