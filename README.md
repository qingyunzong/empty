# 增量 API 时间片二分

审计 API 连接器要可直接接入 TypeScript 时间片规划库，端点对单次结果数量封顶且不提供可靠分页。区间达到上限时二分半开时间窗，相同时间戳用稳定次级游标继续；无法再细分且仍溢出时明确失败。已完成片保存摘要，恢复不重复发布。

## 结构

- `src/planner.ts` — 通用时间片规划库：半开窗 `[startMs, endMs)` 触顶即二分；最小（1ms）窗仍溢出时沿稳定次级游标抽干；游标耗尽仍溢出抛 `SliceOverflowError`，游标不前进抛 `UnstableCursorError`。
- `src/audit-connector.ts` — 审计 API 连接器：`createAuditSliceSource(api, { pageSize })` 把封顶端点适配成规划库的 `SliceSource`，事件 `id` 作为同时间戳的稳定次级游标；`createAuditSync` 一键接好同步管线。
- `src/sync.ts` — `TimeSliceSync`：逐片发布，每片完成后写入摘要检查点。
- `src/checkpoint.ts` — 片摘要（窗口、条数、SHA-256 摘要、首尾键、完成时间）；`MemoryCheckpointStore` 与原子落盘的 `FileCheckpointStore`，恢复时跳过已完成片，不重复发布。

## 用法

```ts
import { FileCheckpointStore, createAuditSync } from "./index.ts";

const sync = createAuditSync(auditApi, {
  store: new FileCheckpointStore("state/checkpoints.json"),
  sink: mySink, // { publish(slice, records) }
  pageSize: 500, // 不超过端点单次上限
});
const report = await sync.run({ startMs, endMs }); // 半开区间
// report.published 本次完成片；report.skipped 恢复跳过的片
```

## 命令

- `npm run typecheck` — 严格类型检查
- `npm test` — 编译到 `build/` 并运行 `node --test`
