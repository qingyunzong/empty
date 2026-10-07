# timeline-rows

把半开区间 `[start, end)` 分配到**最少显示行**的 TypeScript 时间轴库。

## 规则

- 区间为半开：`[0, 2)` 与 `[2, 5)` 不冲突，可共用一行。
- `fixedRow` 固定行请求必须遵守；同一行上固定请求相互重叠时**拒绝整批**
  （抛出 `FixedRowConflictError`，不产生任何分配）。
- 其余条目按 `(start, id)` 顺序放置，每条形同条件下取**最低可用行**。
- 行数最少：从理论下界（扫描线深度 与 最高固定行 + 1 的较大者）向上搜索
  首个可行行数；在下界内按上述顺序回溯，结果确定。无固定行时退化为
  经典 first-fit，不会回溯。
- `relayout` 支持重新排布，并输出搬移差量（新增 / 移动 / 删除）。

## API

```ts
import { layout, relayout, bruteForceMinRows, sweepDepth } from "./src/timeline.js";

const result = layout([
  { id: "a", start: 0, end: 2 },
  { id: "b", start: 1, end: 3, fixedRow: 1 },
]);
// result.rowCount -> 最少行数
// result.rows     -> Map<id, row>

const next = relayout(result, [
  { id: "a", start: 0, end: 2 },
  { id: "c", start: 2, end: 4 },
]);
// next.moves -> [{ id, from, to }]，from/to 为 null 分别表示新增/删除
```

- `bruteForceMinRows(items)`：穷举精确最小行数（遵守固定行），用于小实例验证。
- `sweepDepth(items)`：任意点的最大并发区间数（行数下界之一）。
- `findFixedRowConflicts(items)`：列出同 row 上互相重叠的固定请求对。

## 测试

```sh
npm test   # tsc 编译 + node --test；含小实例穷举最少行验证
```
