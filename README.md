# 分页采集的排序键碰撞恢复

公开目录只提供按更新时间倒序的分页查询，多个条目时间相同且服务端页内次序可变，直接保存最后时间会漏项。本包提供一个可导入的 TypeScript 增量收集器，用时间二分、ID seek、快照 token 和持久化 checkpoint 解决这个问题。

## 快速使用

```ts
import {
  IncrementalTimeCollector,
  InMemoryCheckpointStore,
} from "./index.ts";

const store = new InMemoryCheckpointStore();
const collector = new IncrementalTimeCollector({
  remote,
  k: 100,
  store,
  from: 0n,                 // 可选，默认 INT64_MIN
  to: 10_000_000n,          // 可选，默认 INT64_MAX
});

const controller = new AbortController();
const session = await collector.start();
while (true) {
  const next = await session.next();
  if (next.kind === "done") break;
  if (next.kind === "expired") break;   // 本轮停止，水位未推进
  if (next.kind === "cancelled") break;

  await persistRecords(next.bucket.records); // 可失败、可重试
  const confirmation = await next.bucket.confirm();
  if (!confirmation.confirmed) {
    // cancelled / stale / storage-failed：桶仍未确认
    break;
  }
}
```

同一进程内重新 `start()` 会从存储恢复。发生崩溃时不需要调用 `cancel`；未确认桶的临时记录不会被 checkpoint 保存，恢复后会重新获取。调用方处理记录失败时不要确认，下一次 `next()` 会重复投递同一个桶，不会跳到下一桶。

也可以显式取消：

```ts
session.cancel("operator stopped");
// 或把 AbortSignal 传入 CollectorOptions.signal
```

## 远端契约

```ts
interface SnapshotRemote {
  acquireSnapshot(range: { from: bigint; to: bigint }): Snapshot;
  queryRange(from: bigint, to: bigint, token: string): RangePage;
  seekById(time: bigint, afterId: string | null, token: string): SeekPage;
}

interface RangePage {
  total: bigint | number | string; // 整个闭区间的当前条目数
  records: readonly RemoteRecord[]; // 最多 K 条
}

interface SeekPage {
  records: readonly RemoteRecord[];
  hasMore?: boolean;
}
```

- 所有查询都必须携带 `snapshotToken`。token 失效时远端应抛 `SnapshotExpiredError`，或抛 `code === "SNAPSHOT_EXPIRED"` 的错误。
- `total <= K` 时，`records.length` 必须严格等于 `total`。
- `total > K` 时，`records.length` 不得超过 `K`，也不得超过 `total`。
- 任何页返回的条目时间必须落在查询区间内。seek 页只能返回该时间点，ID 必须严格大于游标且在 UTF-8 字节序下严格递增。
- seek 仅用于“单个时间点 `total > K`”的情况；游标为排他边界，`afterId` 绑定 token 和时间。

## 关键不变量

- 时间统一使用 `bigint`。中点为 `from + floor((to-from)/2)`，不经过浮点数，`[-2^63, 2^63-1]` 也能精确拆分。
- 非叶区间拆成 `[from, mid]` 和 `[mid+1, to]`，二者不重不漏；持续二分直到叶子 `total <= K`。
- 每个叶子按“时间升序、同时间 ID 的 UTF-8 字节序”交付。叶子按时间顺序确认，因此全局交付顺序也满足该排序。
- 每次交付的 `BucketDelivery` 都带 `snapshotToken` 和 `snapshotGeneration`。不同快照的同 ID 内容不会被合并成同一版本。
- 空叶子也会作为空桶交付并要求确认；因此所有水位推进都对应一个被调用方确认的完整时间桶。
- `confirm()` 通过存储提交 checkpoint 后才推进 `confirmedThrough`。存储失败时桶保持未确认，可以重试。

## Checkpoint 与恢复

`Checkpoint` 保存：

- `snapshotToken` / `snapshotGeneration` / `snapshotRange`
- `scan`（原始扫描范围）与 `confirmedThrough`（已确认水位）
- `pending`（有序、连续、覆盖未完成范围的区间）
- `retiredSnapshots`（失效快照的 token、原因和当时未完成区间）

恢复规则：

1. 同一快照仍有效时，从 `confirmedThrough + 1` 继续使用 `pending`，不重扫已确认桶。
2. 快照失效时，先把旧快照和未完成区间写入 `retiredSnapshots`，再对 `[confirmedThrough + 1, scan.to]` 取新快照，重建 `pending = [[start, scan.to]]`。
3. 旧快照下已投递但未确认的记录只保留在 append-only evidence 中，带旧 token；新快照的交付带新 token。不会把两个快照拼成一个连续版本。
4. 旧 token 再次被 `acquireSnapshot` 返回会被拒绝（`SNAPSHOT_TOKEN_REUSED`）。

存储接口：

```ts
interface CheckpointStore {
  loadCheckpoint(): MaybePromise<Checkpoint | null>;
  saveCheckpoint(checkpoint: Checkpoint): MaybePromise<void>; // 应原子
  appendEvidence(evidence: DeliveryEvidence): MaybePromise<void>; // 只追加，不删除旧快照证据
}
```

`InMemoryCheckpointStore` 适合测试和单进程宿主；生产环境请换成事务型持久存储。

## 确认与取消的线性化

- 先调用 `confirm()` 再调用 `cancel()`：确认已保留，允许完成并推进水位；`cancel()` 返回 `after-confirm`，后续 `next()` 返回 cancelled。
- 先调用 `cancel()` 再调用 `confirm()`：确认返回 `{ confirmed: false, reason: "cancelled" }`，水位不推进。
- 查询进行中调用 `cancel()`：本轮当前临时结果丢弃，不交付、不保存水位。
- `AbortSignal` 与 `cancel()` 语义一致。

## 测试

```bash
npm test
npm run typecheck
```

确定性测试覆盖：

- 极端 int64 时间（`INT64_MIN` / `INT64_MAX`）与精确二分
- 密集同时间桶（seek 多页）及 UTF-8 ID 字节序
- `total <= K` 但页短、页条数超过 `total`、页条数超过 `K`
- range / seek 返回查询范围外的时间
- seek 不严格递增、游标不排他、seek 总数与 range total 不一致
- 崩溃后同快照恢复、未确认桶重复投递
- 快照失效恢复、同一 ID 跨快照内容变化的证据保留
- 确认/取消竞态、查询中取消、存储失败重试
- 与固定快照全量“时间升序 + ID 字节序”模型逐条对照
