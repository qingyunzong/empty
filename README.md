# 多级缓存组件

可嵌入的 TypeScript 多级缓存，提供 L1/L2、并发回源合并（single-flight）、TTL 抖动、独立负缓存 TTL，以及按键精确有序的失效广播。

## 快速开始

```ts
import {
  MISS,
  MultiLevelCache,
  MemoryL2Store,
  OrderedInvalidationBus,
} from "dlks-formal-10077";

const bus = new OrderedInvalidationBus<string>();
const l2 = new MemoryL2Store<string, User>();

const cache = new MultiLevelCache<string, User>({
  loader: async (userId) => {
    const user = await db.findUser(userId);
    return user ?? MISS; // MISS 写入负缓存
  },
  ttlMs: 60_000,
  negativeTtlMs: 5_000,
  ttlJitter: 0.15, // 实际 TTL 在 85% ~ 115% 之间随机
  l2,
  invalidation: bus,
  origin: "pod-a", // 每个实例必须唯一
});

const user = await cache.get("u-1");          // User | undefined
const detail = await cache.getDetailed("u-1"); // 含 source / negative / expiresAt

await cache.invalidate("u-1"); // 精确失效该键，并通过 bus 广播
```

`loader` 返回 `MISS` 表示源端确认不存在，而不是异常。负缓存使用 `negativeTtlMs`，与正常值的 `ttlMs` 完全独立。

## 行为语义

- **L1/L2 读取**：先查 L1；未命中查 L2，并将仍然有效的 L2 条目提升到 L1。过期条目会被删除。
- **回源合并**：同一键同一代（generation）的冷请求只创建一个 loader 调用。首个请求来源为 `loader`，其余请求来源为 `single-flight`，等待同一个 Promise；loader 失败也由整组共享。
- **TTL 抖动**：`expiresAt = now + baseTtl * (1 + jitter * (2 * random() - 1))`，随机源可注入，便于测试。
- **负缓存**：负条目独立过期，命中时 `getDetailed()` 返回 `negative: true` 与 `value: undefined`。
- **精确失效**：`invalidate(key)` 只删除该键的 L1/L2，不影响其他键。
- **有序广播**：同一实例的失效任务按调用顺序串行执行并发布；`OrderedInvalidationBus` 以全局调用顺序逐个投递事件。远端实例按 `origin + key` 维护版本号，重复或乱序事件会被丢弃。
- **读写栅栏**：每个键有单调递增的 generation。回源写回前后都校验 generation；失效会递增 generation 并摘除正在进行的回源，因此旧结果仍返回给原等待者，但不会在失效后回写。
- **单键串行化**：L2 写入、失效删除按 key 串行，避免“旧回源清理写”删除“新回源写入”的竞态。
- **失效屏障**：调用失效后立刻发起的读取会等待该键的 L2 删除完成，避免在删除尚未落地时重新读到旧 L2 值。

## 可插拔层

```ts
interface L2Store<K, V> {
  get(key: K): Promise<CacheEntry<V> | undefined> | CacheEntry<V> | undefined;
  set(key: K, entry: CacheEntry<V>): Promise<void> | void;
  delete(key: K): Promise<void> | void;
}
```

默认使用进程内 `MemoryL1Store` / `MemoryL2Store`。生产环境可将 `L2Store` 适配到 Redis、Memcached 等；分布式消息总线实现 `InvalidationTransport` 即可：

```ts
interface InvalidationTransport<K> {
  publish(event: InvalidationEvent<K>): void | Promise<void>;
  subscribe(listener: (event: InvalidationEvent<K>) => void | Promise<void>): () => void;
}
```

`InvalidationEvent` 为 `{ key, version, origin }`。每个缓存实例（包括进程重启后的新实例）的 `origin` 必须唯一；实例会忽略自己发布的事件。

## 观测

`stats()` / `statsFor(key)` 返回：

- `l1Hits`、`l2Hits`、`negativeHits`
- `misses`、`loads`、`coalesced`
- `invalidations`、`staleWritesRejected`、`loadFailures`

`loads` 是真实 loader 调用次数，`coalesced` 是加入已有 single-flight 的请求数。`staleWritesRejected` 统计因失效代际竞争而拒绝的回写。

## 测试

```bash
npm test
```

测试包含：

- 并发冷请求只回源一次，所有等待者拿到同一结果；
- L2 提升、L1 丢失后的 L2 命中、按键精确失效；
- 正/负缓存独立 TTL 与确定性 TTL 抖动边界；
- 失效广播顺序、远端精确失效与重复/乱序事件过滤；
- 回源进行中失效、L2 写入被阻塞时失效，均只允许新代回写；
- 3,401 组并发操作序列穷举，逐步与独立朴素缓存模型核对每个请求的来源、值、负缓存状态，以及每个键的回源次数、L2 写入次数和最终 L1/L2 内容。
