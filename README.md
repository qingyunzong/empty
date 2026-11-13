# 游标分页快照去重

面向第三方 API 连接器的 TypeScript 游标分页组件。它把“抓取”和“确认”分开：只有调用方处理成功并调用 `commit()` 后，游标和已提交水位才会一起持久化。

## 使用

```ts
import { CursorPager, type CheckpointStore } from "./index.ts";

interface Item {
  id: string;
  revision: number;
}

const store: CheckpointStore<number> = {
  async load() {
    return db.getCheckpoint(); // { cursor, watermark, ... }
  },
  async save(checkpoint) {
    await db.putCheckpoint(checkpoint); // 单条记录原子覆盖
  },
};

const pager = new CursorPager<Item, string, number>({
  async fetchPage({ cursor, snapshotToken }) {
    const response = await api.list({ cursor, snapshotToken });
    return {
      items: response.items,
      nextCursor: response.nextCursor,
      snapshotToken: response.snapshotToken,
    };
  },
  getKey: (item) => item.id,
  getVersion: (item) => item.revision,
  checkpointStore: store,
  batchSize: 100,

  async onBatch(records, batch) {
    await sink.write(records); // 必须成功后才允许提交检查点
    console.log(batch.cursor, batch.watermark);
  },
});

await pager.run();
```

也可以手动拉取和提交：

```ts
for (;;) {
  const batch = await pager.nextBatch();
  if (batch === null) break;

  await sink.write(batch.records);
  await pager.commit(batch); // 原子保存 cursor + watermark
}
```

## 语义

- **页面重叠**：同一批次内按 `getKey` 去重；同一键出现较新 `getVersion` 时替换未提交旧版本，并保持原记录位置。
- **已确认键的更新**：同版本不会重发；已提交键出现更高版本时会作为后续更新发出（需要 `getVersion` 能区分新旧）。
- **游标回环**：已请求过的 `nextCursor` 再次出现时停止，默认不重复请求该页；`cursorLoopPolicy: "throw"` 可改为抛出 `CursorLoopError`。
- **快照 token 过期**：识别 `SnapshotExpiredError`、`code: "SNAPSHOT_EXPIRED"`、HTTP 410 等。默认 `resume` 从已提交 `cursor` 重试；同一游标再次失败则从起点重扫。`restart` 总是从头重扫，`throw` 直接抛出。
- **检查点**：`{ cursor, watermark, watermarkKeys, snapshotToken, exhausted }` 一次性写入。`watermark` 是已提交记录的最高版本；`watermarkKeys` 是恰好等于水位的键，用于避免重扫时把同版本、尚未提交的记录误跳过。
- **重启一致性**：未提交批次会从检查点重抓；已提交记录由水位和键集合过滤。没有版本号时，游标仍然生效，但无法在全量重扫中精确判断“同键不同内容”的新旧关系，建议提供 `getVersion`。
- **版本顺序**：水位过滤假定记录版本随更新单调递增，且源分页按版本/更新时间递增返回；若接口使用语义版本或自定义排序，请传 `compareVersions`。
- **键可序列化**：`getKey` 的返回值会写入检查点中的 `watermarkKeys`，应使用可稳定序列化的值（通常是字符串 ID）。
- **最多一次发出已确认记录**：提交成功后同一批次不会被再次发出。进程在写入下游之后、检查点保存之前崩溃时，仍可能重放该未确认批次（至少一次语义）；下游应按去重键幂等。
- **`maxPages`**：达到安全上限时只暂停并保留可恢复游标，不会把检查点标记为已耗尽。

## 主要导出

- `CursorPager` / `CursorPaginator`：拉取式分页器。
- `createCursorPager`：工厂函数。
- `collectCursorPages`：一次性收集有界数据集。
- `SnapshotExpiredError`、`InvalidCursorError`、`CursorLoopError`、`SnapshotRecoveryError` 等错误类型。
- `Checkpoint`、`CheckpointStore`、`Page`、`FetchPageRequest`、`CursorBatch` 等类型。

## 验证

```bash
npm test       # 编译源码后运行 node:test
npm run typecheck
```
