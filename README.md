# 目录分区发现水位

数据湖采集器需要可导入的 TypeScript 分区发现状态库，从最终一致的目录列举中识别 hive 风格分区。新目录需连续两次观察并有完成标记才发布；暂时消失不立即删除。每轮保存 continuation token、清单世代和待确认项，重启后不重复发布。

## 语义

- **发布**：新目录需连续 `requiredConsecutiveObservations`（默认 2）轮被观察到，且至少一次带完成标记（`complete: true`，对应 `_SUCCESS`），才发出 `published` 事件。
- **移除**：已发布分区暂时消失不立即删除；连续缺席超过 `missingRoundsBeforeRemoval`（默认 2）轮才发出 `removed` 事件，宽限期内重新出现则归零缺席计数。
- **幂等**：每轮持久化 `continuationToken`、`lastGeneration`（清单世代）与 `pending` 待确认项；世代未前进的批次被忽略（`stale: true`），重启后重放同一世代不会重复发布。
- **过滤**：仅接受 hive 风格路径（每段 `key=value`，如 `dt=2026-11-15/hour=08`），其余路径忽略。

## 使用

```ts
import { FileStateStore, PartitionDiscovery } from "dlks-de-0164";

const discovery = await PartitionDiscovery.open(
  new FileStateStore("/var/lib/collector/partition-state.json"),
);

const events = await discovery.applyRound({
  generation: manifestGeneration,       // 单调递增
  continuationToken: listingToken,      // 下一轮续传列举
  entries: [
    { path: "dt=2026-11-15/hour=08", complete: true },
  ],
});
// events.published / events.removed 即本轮应同步给下游的变更
```

核心逻辑同时以纯函数 `reduceRound(state, batch, options)` 导出，便于自行接管持久化；`StateStore` 为持久化接口，可替换为数据库等实现。

## 脚本

- `npm run build`：编译到 `dist/`（含 `.d.ts`）。
- `npm test`：编译并运行 `node:test` 测试。
- `npm run typecheck`：仅类型检查。
