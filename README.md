# diagnostic-store

TypeScript 诊断库：按来源 ID 合并重复错误、保留多阶段证据、支持来源撤回，输出稳定排序。仅依赖 Node.js 内置库（`node:test` / `node:assert`），无第三方运行时依赖。

## 语义规则

- **合并键**：`(code, message, cause, range)` 完全相同的错误合并为一条诊断；同一 `(sourceId, stage)` 的重复上报去重为一份证据。
- **相邻范围不同原因不合并**：`cause` 是合并键的一部分，范围相邻（如 `[0,5)` 与 `[5,9)`）但原因不同的错误始终保留为独立条目。
- **多阶段证据**：同一错误被多个阶段/来源引用时，每份 `(sourceId, stage)` 证据都保留在 `evidence` 列表中。
- **来源撤回**：`withdrawSource(sourceId)` 只移除该来源的引用；仍有其他来源引用的诊断保留，最后一份引用移除后诊断消失。
- **稳定排序**：诊断按 `(range.start, range.end, code, cause, message)` 排序，证据按 `(sourceId, stage)` 排序，与插入顺序无关；返回值为快照副本，不共享内部状态。

## API

```ts
import { DiagnosticStore } from "./src/diagnostics.js";

const store = new DiagnosticStore();
store.report({ sourceId, stage, code, message, cause, range: { start, end } });
store.withdrawSource(sourceId);
const diagnostics = store.diagnostics(); // 稳定排序的快照
```

## 测试

```
npm test   # tsc 编译后运行 node --test
```

- `test/diagnostics.test.ts`：合并、相邻范围不同原因不合并、多阶段证据保留、来源撤回、稳定排序、快照隔离、非法输入校验。
- `test/property.test.ts`：基于种子的随机操作序列（65% 上报 / 35% 随机撤回，5 个种子 × 2000 步），每步与全量集合参考模型 `test/model.ts`（从当前完整报告集合重新聚合）逐步比对；另验证同种子输出确定性。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行。

```
ok 1 - dist/test/diagnostics.test.js
ok 2 - dist/test/property.test.js
# tests 2
# pass 2
# fail 0
```

单元测试 9 例 + 属性测试 2 例（含 5 种子 × 2000 步随机撤回对账）全部通过。
