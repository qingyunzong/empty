# provenance-merge

字段级资料合并库：每个字段记录来源版本与转换链，同值多来源合并、异值冲突，
撤回来源只移除其贡献，无来源字段自动消失，并输出净差分。
仅使用 TypeScript + Node.js 内置模块，零运行时依赖。

## 核心语义

- **来源与版本**：每个来源以 `{ id, version, record }` 加入；同 id 再加入视为新版本，整体替换其贡献。
- **转换链**：按字段配置具名转换（`trim`、`lower`、`round2` 等，可自定义注册），
  比较与合并使用转换后的值，原始值与转换链一并记入 `Provenance`。
- **合并规则**：字段所有贡献的转换值一致 → `status: "value"`，保留全部来源；
  不一致 → `status: "conflict"`，`candidates` 列出每个候选值及其来源集合。
- **撤回**：`withdrawSource(id)` 只删除该来源的贡献；字段失去所有来源后消失。
  撤回不存在的来源返回空差分（幂等）。
- **净差分**：`addSource` / `withdrawSource` 均返回 `MergeDiff`，
  每项 `{ field, before, after }`（`null` 表示字段此前不存在 / 现已消失），
  仅包含实际发生变化的字段，且差分可精确重放到快照上。

## 使用示例

```ts
import { MergeStore } from "./src/index.js";

const store = new MergeStore({ fieldTransforms: { city: ["trim", "lower"] } });
store.addSource({ id: "crm", version: 1, record: { city: "  Berlin ", score: 10 } });
store.addSource({ id: "erp", version: 2, record: { city: "BERLIN", score: 20 } });

store.getField("city");  // { status: "value", value: "berlin", sources: [crm, erp] }
store.getField("score"); // { status: "conflict", candidates: [10←crm, 20←erp] }

const diff = store.withdrawSource("erp");
// diff.changes: city 少一个来源（值不变），score 由冲突收敛为 10
```

## 正确性对照

`test/merge.test.ts` 的随机化测试（100 轮，种子可复现）：
随机生成来源、字段子集与转换链，随机顺序逐个撤回，每步同时断言

1. 增量状态 === 用剩余来源全量重建（`MergeStore.rebuild`）的状态；
2. 累计净差分重放到影子快照 === 当前快照。

## 运行测试

需要全局可用的 `tsc`（TypeScript ≥ 5）与 Node.js ≥ 18。

```sh
npm test   # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，`npm test` 一次通过。

```
ok 1 - same value from multiple sources merges into one value with all provenance
ok 2 - transform chain is recorded per contribution and applied before comparison
ok 3 - different values produce a conflict with all candidates
ok 4 - withdrawing a source removes only its contributions and emits a net diff
ok 5 - a field disappears once its last source is withdrawn
ok 6 - withdrawing an unknown source is a no-op with an empty diff
ok 7 - re-adding a source with a new version replaces its contributions
ok 8 - net diffs replay exactly onto a shadow snapshot
ok 9 - random withdrawals match a full rebuild from the remaining sources
# tests 9
# pass 9
# fail 0
```

（`node --test` 在此 Node 版本按文件聚合报告为 `tests 1 / pass 1`；
上表为直接执行编译产物 `node dist/test/merge.test.js` 的逐条结果。）

## 目录结构

- `src/transforms.ts` — 具名转换注册表与内置转换
- `src/merge.ts` — `MergeStore`：合并、撤回、净差分、快照、全量重建
- `src/index.ts` — 公共导出
- `test/merge.test.ts` — 单元测试 + 随机撤回 vs 全量重建对照
- `types/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明（避免外部依赖）
