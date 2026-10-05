# pivot-exact

多层行列键的精确整数透视库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），零 npm 依赖。

## 特性

- **多层行列键**：行键、列键均为任意层级的键路径（`KeyPart[]`），
  键分量可以是字符串、有限数字或 `null`。
- **NULL 独立分类**：`null` 是独立类别，与字符串 `"null"`、数字 `0`、
  缺失层级（更短的键）互不混淆（见 `src/key.ts` 的分量标签编码）。
- **精确整数**：内部一律使用 `bigint`；`number` 输入必须是安全整数，
  字符串输入必须是整数字面量，越界/浮点在入口处即拒绝（`src/events.ts`）。
- **小计不重复计算叶数据**：存储层只维护叶组（完整行键 × 完整列键）的
  和与计数；小计由叶数据沿行/列前缀逐级上卷，每个叶对每个
  （行前缀 × 列前缀）单元格恰好贡献一次（`src/pivot.ts`）。
- **更正带事件 ID**：`insert` / `adjust`（调额）/ `move`（跨组迁移）
  三类事件均携带唯一事件 ID；相同 ID 重复摄入为幂等空操作，
  指向不存在目标的更正会被拒绝（`src/store.ts`）。
- **树状输出及总计**：`formatPivot` 输出行树、每行节点的列细分树和
  总计行；`buildPivot` 返回结构化树。
- **全表分组核对**：`reconcile` 用独立的朴素 filter+sum（全表 GROUP BY）
  逐叶组、逐小计单元格、逐总计三级核对，覆盖空组（记录全部迁出的组
  必须消失，零和有记录的组必须保留）与跨组迁移（源组减、目标组增、
  总计守恒）（`src/reconcile.ts`）。

## 使用

```bash
npm test    # 编译 (tsc) 并运行 node:test 测试
npm run demo  # 运行示例，打印树状透视与核对结果
```

```ts
import { PivotStore, buildPivot, formatPivot, reconcile } from "./src/index";

const store = new PivotStore();
store.ingest({ kind: "insert", id: "o1", row: ["CN", "BJ"], col: ["2026", "Q1"], value: 120 });
store.ingest({ kind: "adjust", id: "fix-1", target: "o1", delta: -20 });      // 更正：调额
store.ingest({ kind: "move", id: "fix-2", target: "o1", row: ["CN", "SH"] }); // 更正：跨组迁移

const pivot = buildPivot(store);
console.log(formatPivot(pivot));
console.log(reconcile(store, pivot).ok); // true
```

注：本环境 Node v22.22.1 未内置 TypeScript 支持，测试脚本使用全局
`tsc`（7.0.2）编译到 `dist/` 后由 `node --test` 运行；`types/node-shims.d.ts`
提供 `node:test` / `node:assert` 的最小类型声明以替代 `@types/node`。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（TAP 汇总）：

```
# tests 1
# pass 1
# fail 0
# duration_ms 354.141923
```

子进程内 9 个用例明细（`node dist/test/pivot.test.js`）：

```
ok 1 - multi-level row/column aggregation with grand total
ok 2 - NULL is its own category, distinct from 'null', 0 and missing levels
ok 3 - subtotals equal the sum of their children at every level (no double count)
ok 4 - exact integers beyond 2^53; unsafe numbers rejected
ok 5 - corrections carry event ids and are idempotent
ok 6 - cross-group migration moves value, empties source group, conserves total
ok 7 - zero-sum group with live records is kept; empty group is dropped
ok 8 - reconciliation holds for a randomized event stream
ok 9 - tree rendering shows row/column levels and the grand total
# tests 9
# pass 9
# fail 0
```

`npm run demo` 实际输出（含 2^53 以上的精确整数、NULL 类别、
一笔调额更正与一笔跨组迁移更正）：

```
row ["CN"]  sum=195  n=3
  col ["2026"]  sum=195  n=3
    col ["2026" / "Q1"]  sum=115  n=2
    col ["2026" / "Q2"]  sum=80  n=1
  row ["CN" / "BJ"]  sum=100  n=1
    col ["2026"]  sum=100  n=1
      col ["2026" / "Q1"]  sum=100  n=1
  row ["CN" / NULL]  sum=15  n=1
    col ["2026"]  sum=15  n=1
      col ["2026" / "Q1"]  sum=15  n=1
  row ["CN" / "SH"]  sum=80  n=1
    col ["2026"]  sum=80  n=1
      col ["2026" / "Q2"]  sum=80  n=1
row [NULL]  sum=9007199254740993  n=1
  col [NULL]  sum=9007199254740993  n=1
  row [NULL / "EXPRESS"]  sum=9007199254740993  n=1
    col [NULL]  sum=9007199254740993  n=1
TOTAL  sum=9007199254741188  n=4
reconciled with full-table GROUP BY: OK
```

## 目录结构

- `src/key.ts` — 键分量/键路径的无歧义编码与前缀枚举
- `src/events.ts` — 事件类型与精确整数入口校验
- `src/store.ts` — 事件溯源存储：ID 去重、叶组增量维护、空组清除
- `src/pivot.ts` — 叶数据上卷为行/列树、树状文本渲染
- `src/reconcile.ts` — 与独立全表 GROUP BY 的三级核对
- `test/pivot.test.ts` — 9 个 `node:test` 用例（含随机事件流回归）
- `examples/demo.ts` — 端到端示例
