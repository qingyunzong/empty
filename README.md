# provenance-merge

带溯源的字段级合并库（TypeScript + Node.js 内置库，零运行时依赖）。

## 语义

- **溯源**：每个字段记录每条贡献的 `source`（来源）、`version`（源版本）、`chain`（转换链）与 `raw`（原始值）。
- **合并**：同一字段的取值按规范化后的值分组；只有一个不同值时字段为 `resolved`（可有多来源），存在多个不同值时为 `conflict`。
- **撤回**：`retract(source)` 只移除该源的贡献；字段不再有任何来源时整个字段消失。
- **净差分**：`apply` / `retract` 返回 `NetDiff`（逐字段 `{field, from, to}` 快照迁移），只包含实际发生变化的字段。
- **确定性**：视图中的值组按规范值排序、贡献按 `(source, version)` 排序，因此增量撤回的结果与用剩余源全量重建的结果逐字节一致。

## API

```ts
import { MergeStore } from "./src/merge.js";

const store = new MergeStore();
const trim = { name: "trim", apply: (v: unknown) => typeof v === "string" ? v.trim() : v };

store.apply("srcA", 1, { name: " Alice " }, [trim]);   // => NetDiff
store.apply("srcB", 2, { name: "Alice" });             // 同值合并，多来源
store.apply("srcC", 1, { name: "Alicia" });            // 不同值 => conflict
store.retract("srcC");                                 // 净差分: name 回到 resolved
store.get("name");                                     // FieldView（含 values/sources/chain）
store.view();                                          // 全部字段视图
```

## 测试

```
npm test
```

流程：`tsc -p tsconfig.json` 编译到 `dist/`，再用 `node --test` 运行。
随机化对照测试（40 个种子 × 8 个源）：逐个随机撤回源，每步都将增量视图与
「剩余源全量重建」的视图做深度比较，并校验净差分能精确复现前后视图迁移。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - same value from multiple sources merges with full provenance
ok 2 - different values produce a conflict with per-value sources
ok 3 - retract removes only the retracted source's contribution
ok 4 - field disappears when its last source is retracted
ok 5 - retracting one side of a conflict resolves the field
ok 6 - transform chain is recorded and normalizes values into a merge
ok 7 - same transform chain on both sides merges raw-different values
ok 8 - re-applying a source with a new version replaces its contributions
ok 9 - net diff reports added, changed, removed and conflict transitions
ok 10 - random retractions match full rebuild from remaining sources
# tests 10
# pass 10
# fail 0
```
