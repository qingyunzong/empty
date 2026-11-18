备份服务需要可嵌入的TypeScript时间线组件，把归档日志按分支点组织成可恢复时间线，处理恢复目标、分支切换与归档缺口。新分支只能从已封闭时间线的有效点派生，时间线图不得成环，缺口未补齐前该点之后不可恢复。用小日志历史穷举，对照全量时间线重算核对分支可达性与恢复点，分支创建与归档到达交错时已封闭时间线不被改写。

## 组件

`TimelineStore`（见 `src/timeline.ts`，入口 `index.ts`）是无 I/O 的可嵌入时间线组件：

- `createRoot(id)` / `createBranch(id, parentId, atLsn)`：新分支只能从**已封闭**父时间线的**可恢复点**派生，且分支点必须落在父时间线自身区间内；图结构天然无环，`validate()` 与 `restore()` 会再次校验。
- `archiveSegment(id, start, end)`：登记归档段 `[start, end)`；已封闭时间线拒绝写入（`TIMELINE_SEALED`），迟到归档不会改写历史。
- `seal(id)`：封闭时间线，之后其内容冻结，方可作为分支父节点。
- `isRecoverable(id, lsn)` / `recoverableUpTo(id)`：沿祖先链从 0 连续覆盖才可恢复；缺口未补齐前，缺口之后的点不可恢复。
- `recoveryPath(id, lsn)`：恢复目标的路径，按分支点列出时间线切换（hop）。
- `findRecoverableTimelines(lsn)` / `reachableFrom(id)`：恢复目标解析与分支可达性。
- `snapshot()` / `TimelineStore.restore(snapshot)`：可持久化的纯 JSON 快照，恢复时重放全部规则校验。

## 测试

```sh
npm test
```

先由 `tsc` 编译到 `build/`，再用 `node --test` 运行：

- `test/timeline.test.ts`：针对恢复目标、分支切换、归档缺口、封闭保护的单元测试。
- `test/exhaustive.test.ts`：在小日志历史上穷举全部操作交错（2 时间线深度 6、3 时间线深度 5，按状态去重），每步对照**全量重算**的独立 oracle 核对分支可达性与恢复点；并以固定种子模糊测试长历史，验证已封闭时间线在分支创建与归档到达交错时不被改写、被拒绝的操作不产生副作用。
