/**
 * 配置库：支持字符串中 ${key} 的递归展开。
 *
 * 语义：
 * - `${key}` 递归展开为对应配置项解析后的值；
 * - 引用的键不存在时抛出 MissingKeyError（而非替换为空串）；
 * - `\${key}` 为转义占位，输出字面量 `${key}`（反斜杠被消费）；
 * - 循环引用抛出 CircularReferenceError，路径从请求键开始；
 * - 解析结果按依赖版本缓存：配置项每次 set 递增版本，
 *   缓存项记录其依赖键的版本快照，仅当任一依赖版本变化时失效。
 */

export class MissingKeyError extends Error {
  override readonly name = "MissingKeyError";

  constructor(
    public readonly key: string,
    public readonly path: readonly string[],
  ) {
    super(
      `Missing config key "${key}" (resolution path: ${path.join(" -> ")})`,
    );
  }
}

export class CircularReferenceError extends Error {
  override readonly name = "CircularReferenceError";

  constructor(public readonly path: readonly string[]) {
    super(`Circular reference detected: ${path.join(" -> ")}`);
  }
}

interface CacheEntry {
  value: string;
  /** 解析该键时观测到的依赖键 -> 版本快照（含键自身）。 */
  deps: ReadonlyMap<string, number>;
}

export class ConfigStore {
  private readonly values = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly cache = new Map<string, CacheEntry>();

  /** 设置（或覆盖）配置项，递增其版本号。 */
  set(key: string, value: string): this {
    this.values.set(key, value);
    this.versions.set(key, this.versionOf(key) + 1);
    return this;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  /** 带缓存解析：缓存新鲜时直接返回，否则重新解析并记录依赖版本。 */
  get(key: string): string {
    return this.resolveKey(key, [key], true).value;
  }

  /** 无缓存解析：每次都完整展开，用作缓存结果的对照。 */
  getUncached(key: string): string {
    return this.resolveKey(key, [key], false).value;
  }

  /** 缓存项是否仍然新鲜（所有依赖版本均未变化）。 */
  isCacheFresh(key: string): boolean {
    const cached = this.cache.get(key);
    return cached !== undefined && this.isFresh(cached);
  }

  private versionOf(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private isFresh(entry: CacheEntry): boolean {
    for (const [dep, version] of entry.deps) {
      if (this.versionOf(dep) !== version) {
        return false;
      }
    }
    return true;
  }

  private resolveKey(
    key: string,
    path: string[],
    useCache: boolean,
  ): CacheEntry {
    if (useCache) {
      const cached = this.cache.get(key);
      if (cached && this.isFresh(cached)) {
        return cached;
      }
    }
    const raw = this.values.get(key);
    if (raw === undefined) {
      throw new MissingKeyError(key, path);
    }
    const deps = new Map<string, number>([[key, this.versionOf(key)]]);
    const value = this.expand(raw, path, deps, useCache);
    const entry: CacheEntry = { value, deps };
    if (useCache) {
      this.cache.set(key, entry);
    }
    return entry;
  }

  private expand(
    raw: string,
    path: string[],
    deps: Map<string, number>,
    useCache: boolean,
  ): string {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      // 转义：\${ 输出字面量 ${
      if (ch === "\\" && raw.startsWith("${", i + 1)) {
        out += "${";
        i += 3;
        continue;
      }
      if (ch === "$" && raw[i + 1] === "{") {
        const end = raw.indexOf("}", i + 2);
        if (end === -1) {
          // 未闭合的占位按字面量处理
          out += raw.slice(i);
          break;
        }
        const ref = raw.slice(i + 2, end);
        if (path.includes(ref)) {
          throw new CircularReferenceError([...path, ref]);
        }
        const child = this.resolveKey(ref, [...path, ref], useCache);
        for (const [dep, version] of child.deps) {
          deps.set(dep, version);
        }
        out += child.value;
        i = end + 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }
}
