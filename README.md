# Savepoint 算子 UID 映射

流作业升级器要可直接接入 TypeScript savepoint 映射组件，根据稳定 operator UID、并行度、max parallelism 与 key-group range 把旧状态分配给新 subtask。UID 缺失、重复或状态 schema 不兼容时给出具体阻断；scale in/out 后每个 key-group 恰好归属一次。

## 用法

```ts
import { mapSavepoint } from "./index.js";

const result = mapSavepoint(savepoint, {
  operators: [
    { uid: "map", parallelism: 4, schema: { kind: "keyed-value", serializer: "kryo", version: 2 } },
  ],
  allowNonRestoredState: false, // 默认：savepoint 中未被引用的状态一律阻断
});
// result.operators[*].subtasks[*]：新 subtask 的 key-group 区间与来源状态句柄
// result.report：scale 变化与被丢弃算子
```

- key-group 划分语义与 Flink `KeyGroupRangeAssignment` 一致，`maxParallelism` 不可变更。
- 阻断错误统一为 `SavepointMappingError`，`code` 区分原因：`MISSING_UID` / `DUPLICATE_UID` / `UNMATCHED_UID` / `INCOMPATIBLE_SCHEMA` / `MAX_PARALLELISM_MISMATCH` / `INVALID_PARALLELISM` / `INVALID_SAVEPOINT` / `KEY_GROUP_COVERAGE`。
- schema 兼容规则：`kind`、`serializer` 必须一致，`version` 默认要求一致，可用 `acceptedVersions` 声明兼容旧版本。

## 脚本

- `npm run typecheck`：类型检查（noEmit）。
- `npm test`：编译到 `dist/` 后运行 `node --test`（本机 Node 未内置 type-stripping，故先编译）。
