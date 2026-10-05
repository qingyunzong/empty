export interface CacheOptions {
  ttlMs?: number;
  maxEntriesPerNamespace?: number;
  now?: () => number;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

class Namespace {
  readonly entries = new Map<string, Entry>();
  readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(readonly generation: number) {}
}

interface ReadResult {
  found: boolean;
  value?: unknown;
}

export class GenerationCache {
  private readonly namespaces = new Map<string, Namespace>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
    this.maxEntries = options.maxEntriesPerNamespace ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
  }

  generation(tenant: string, resource: string): number {
    return this.namespaces.get(scopeKey(tenant, resource))?.generation ?? 0;
  }

  async get<V>(
    tenant: string,
    resource: string,
    key: string,
    loader: () => Promise<V>,
  ): Promise<V> {
    const ns = this.namespaceFor(tenant, resource);

    const hit = this.readEntry(ns, key);
    if (hit.found) return hit.value as V;

    const pending = ns.inFlight.get(key);
    if (pending) {
      return pending as Promise<V>;
    }

    const promise = this.load(ns, key, loader);
    ns.inFlight.set(key, promise);
    return promise;
  }

  revoke(tenant: string, resource: string): number {
    const key = scopeKey(tenant, resource);
    const current = this.namespaces.get(key);
    const next = new Namespace((current?.generation ?? -1) + 1);
    this.namespaces.set(key, next);
    return next.generation;
  }

  evict(tenant: string, resource: string, key: string): boolean {
    const ns = this.namespaces.get(scopeKey(tenant, resource));
    if (!ns) return false;
    ns.inFlight.delete(key);
    return ns.entries.delete(key);
  }

  clear(): void {
    this.namespaces.clear();
  }

  private async load<V>(
    ns: Namespace,
    key: string,
    loader: () => Promise<V>,
  ): Promise<V> {
    try {
      const value = await loader();
      this.publish(ns, key, value);
      return value;
    } finally {
      ns.inFlight.delete(key);
    }
  }

  private namespaceFor(tenant: string, resource: string): Namespace {
    const key = scopeKey(tenant, resource);
    let ns = this.namespaces.get(key);
    if (!ns) {
      ns = new Namespace(0);
      this.namespaces.set(key, ns);
    }
    return ns;
  }

  private readEntry(ns: Namespace, key: string): ReadResult {
    const entry = ns.entries.get(key);
    if (!entry) return { found: false };
    if (entry.expiresAt <= this.now()) {
      ns.entries.delete(key);
      return { found: false };
    }
    ns.entries.delete(key);
    ns.entries.set(key, entry);
    return { found: true, value: entry.value };
  }

  private publish(ns: Namespace, key: string, value: unknown): void {
    if (!ns.entries.has(key) && ns.entries.size >= this.maxEntries) {
      const oldest = ns.entries.keys().next();
      if (!oldest.done) ns.entries.delete(oldest.value);
    }
    ns.entries.delete(key);
    ns.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

function scopeKey(tenant: string, resource: string): string {
  return JSON.stringify([tenant, resource]);
}
