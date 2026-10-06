export class ConfigError extends Error {}

export class MissingKeyError extends ConfigError {
  readonly key: string;
  readonly chain: string[];
  constructor(key: string, chain: string[]) {
    super(`missing key "${key}" (resolving ${[...chain, key].join(" -> ")})`);
    this.name = "MissingKeyError";
    this.key = key;
    this.chain = [...chain, key];
  }
}

export class CycleError extends ConfigError {
  readonly path: string[];
  constructor(path: string[]) {
    super(`circular reference: ${path.join(" -> ")}`);
    this.name = "CycleError";
    this.path = path;
  }
}

export class UnterminatedPlaceholderError extends ConfigError {
  constructor(template: string) {
    super(`unterminated placeholder in "${template}"`);
    this.name = "UnterminatedPlaceholderError";
  }
}

interface CacheEntry {
  value: string;
  deps: Map<string, number>;
}

interface Resolved {
  value: string;
  deps: Map<string, number>;
}

function expand(template: string, lookup: (name: string) => string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "\\" && template[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (ch === "$" && template[i + 1] === "{") {
      const end = template.indexOf("}", i + 2);
      if (end === -1) throw new UnterminatedPlaceholderError(template);
      out += lookup(template.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export class ConfigStore {
  private readonly values = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly cache = new Map<string, CacheEntry>();
  readonly computeCounts = new Map<string, number>();

  constructor(entries?: Record<string, string>) {
    if (entries) {
      for (const [key, value] of Object.entries(entries)) this.set(key, value);
    }
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  delete(key: string): void {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  get(key: string): string {
    return this.resolve(key, [], true).value;
  }

  resolveUncached(key: string): string {
    return this.resolve(key, [], false).value;
  }

  cachedKeys(): string[] {
    return [...this.cache.keys()];
  }

  private versionOf(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private lookupCache(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    for (const [dep, version] of entry.deps) {
      if (this.versionOf(dep) !== version) {
        this.cache.delete(key);
        return undefined;
      }
    }
    return entry;
  }

  private resolve(key: string, stack: string[], useCache: boolean): Resolved {
    const raw = this.values.get(key);
    if (raw === undefined) throw new MissingKeyError(key, stack);
    if (stack.includes(key)) throw new CycleError([...stack, key]);
    if (useCache) {
      const hit = this.lookupCache(key);
      if (hit) return { value: hit.value, deps: hit.deps };
    }
    if (useCache) this.computeCounts.set(key, (this.computeCounts.get(key) ?? 0) + 1);
    const nextStack = [...stack, key];
    const deps = new Map<string, number>();
    const value = expand(raw, (name) => {
      const child = this.resolve(name, nextStack, useCache);
      for (const [dep, version] of child.deps) deps.set(dep, version);
      return child.value;
    });
    deps.set(key, this.versionOf(key));
    const resolved: Resolved = { value, deps };
    if (useCache) this.cache.set(key, { value, deps });
    return resolved;
  }
}
