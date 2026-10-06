/** 加载函数：为指定键异步产出值。 */
export type Loader<K, V> = (key: K) => Promise<V>;

interface Entry<V> {
  /** 世代令牌：被 Promise 闭包捕获，用于区分同一键的不同世代。 */
  readonly token: symbol;
  readonly promise: Promise<V>;
}

/**
 * 进行中 Promise 的 LRU 缓存。
 *
 * - 同键并发请求共享同一个进行中 Promise（去重）；
 * - 容量超限按 LRU 淘汰最久未使用的条目；
 * - 淘汰只移除索引、不取消 Promise，已有等待者照常收到结果；
 * - 已淘汰世代的迟到结果不会写回缓存（世代隔离）；
 * - 淘汰或失败后，同键再请求会创建新任务（新世代）；
 * - Promise 失败时仅当该条目仍是当前世代才删除，允许后续重试。
 */
export class PromiseCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K, loader: Loader<K, V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      // LRU：命中后移到最新使用位置。
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }

    const token = Symbol("generation");
    const promise = (async (): Promise<V> => {
      try {
        return await loader(key);
      } catch (reason) {
        // 失败删除：仅当缓存中仍是本世代才移除；
        // 已淘汰世代的迟到失败不得误删新世代条目。
        if (this.entries.get(key)?.token === token) {
          this.entries.delete(key);
        }
        throw reason;
      }
    })();

    this.entries.set(key, { token, promise });
    this.evictOverflow();
    return promise;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K;
      // 仅删除索引；Promise 不可取消，已持有它的等待者不受影响。
      this.entries.delete(oldest);
    }
  }
}
