# 搜索索引增量别名切换

可导入的 TypeScript 索引世代协调器。它在同一状态机内完成：

1. 创建目标世代并等待全量 backfill 完整结束；
2. 从 backfill 覆盖的 `sourceVersion` 之后读取变更，按 source version 升序补齐；
3. 支持迁移期双写；目标写入失败时把变更持久化为可重放的 gap；
4. 仅在补齐且无未恢复 gap 时，对读写 alias 做一次条件切换；
5. 切换后回读 alias/目标世代；旧世代等到读者租约结束后才删除。

## 快速接入

```ts
import {
  IndexGenerationCoordinator,
  type ChangeFeed,
  type IndexGenerationBackend,
  type ReaderLeaseRegistry,
} from "./index.js";

const backend: IndexGenerationBackend = {
  async createGeneration({ id }) {
    return search.createIndex(id);
  },
  async backfill(generation) {
    const checkpoint = await search.backfill(generation);
    return { sourceVersion: checkpoint.sequence, completed: true };
  },
  async applyChanges(generation, changes) {
    await search.bulk(generation, changes);
  },
  getAliases: () => search.getAliases(),
  compareAndSwapAliases: (expected, target) =>
    search.casAliases(expected, target),
  verifyReadback: (generation) => search.readGenerationProbe(generation),
  deleteGeneration: (generation) => search.deleteIndex(generation),
};

const feed: ChangeFeed = {
  readChanges: ({ afterVersion, throughVersion, limit }) =>
    cdc.read(afterVersion, throughVersion, limit),
  getHighWatermark: () => cdc.highWatermark(),
};

const leases: ReaderLeaseRegistry = {
  getActiveLeases: (generation, at) =>
    leaseStore.activeFor(generation, at),
};

const coordinator = new IndexGenerationCoordinator({
  backend,
  changeFeed: feed,
  readerLeases: leases,
  targetGeneration: "search-v42",
});

const result = await coordinator.run();
```

迁移期间也可以显式双写：

```ts
const outcome = await coordinator.dualWrite(change);
if (outcome.status === "gap") {
  // 缺口已写入 gapJournal；后续可调用 retryOpenGaps() 重放。
}
```

## 约束与行为

- `backfill()` 必须返回 `{ sourceVersion, completed: true }`。未完成或缺少检查点时不会进入补齐。
- `readChanges()` 使用 `afterVersion`（不含）和 `throughVersion`（含）语义；协调器会对每页再次排序和过滤。
- 每轮补齐后会复核 high watermark。源持续前进超过 `maxCatchUpRounds` 时拒绝切换，而不是带着不确定的尾差切换。
- `compareAndSwapAliases(expected, target)` 必须原子比较当前读写 alias。切换尝试只发出一次；即使回读验证失败也不会再次 swap，避免双切。
- `dualWrite()` 先确保当前写 alias 成功；目标写失败会记录 `DualWriteGap`。未恢复 gap 存在时 `switchAliases()` 抛出 `OpenGapError`。
- 默认 `InMemoryGapJournal` 适合单进程；生产环境应注入持久化 `gapJournal`，以保证进程重启后仍可重放缺口。
- `beforeSwitch` 是最终静默点，适合暂停写入或开启短暂双写；调用返回后协调器会再补齐一次并复核 high watermark。
- `cleanupRetiredGenerations()` 只有在该世代不再是读写 alias、且 `getActiveLeases()` 返回空列表时才删除。没有租约注册表时默认保留，避免误删。
- `run()` 可重入：并发调用共享同一执行；成功后可重复读取结果。失败后不会自动重试单次 alias 切换。

## 测试

```bash
npm test
```

测试覆盖版本排序补齐、缺口位于高版本时的重放顺序、双写缺口恢复与切换阻断、读者租约延迟删除、单次切换、回读失败和 high watermark 不收敛。
