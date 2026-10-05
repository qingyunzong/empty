# null3vl-query-optimizer

NULL 三值逻辑（3VL）下的关系查询重写库。TypeScript 编写，仅使用 Node.js 内置模块，
零运行时依赖（TypeScript 编译器为唯一开发期工具）。

## 语义模型

- **包语义**：表与查询结果均为行多重集，重复行保留并参与等价核对（`src/table.ts` 的 `multisetEqual` 逐行计数比较）。
- **三值逻辑**：`TRUE / FALSE / UNKNOWN`，`AND` 取小、`OR` 取大、`NOT` 翻转（`src/values.ts`）。
  NULL 参与任何比较得 `UNKNOWN`；过滤与连接只保留谓词为 `TRUE` 的行（`src/expr.ts`、`src/plan.ts`）。
- **计划算子**：`scan / filter / project / innerJoin / leftJoin`（左外连接未匹配左行补 NULL）。

## 重写规则与公开前置条件（`src/rules.ts`）

每条规则先求值公开前置条件，全部成立才执行，并签发重写证书（规则名、逐项前置条件、
before/after 计划、合法性依据）。前置不满足时计划原样返回，证书记录 `applied=false`。

| 规则 | 前置条件 | 依据 |
| --- | --- | --- |
| R1 过滤下推穿过投影 | 谓词列 ⊆ 投影列 | 投影不改写保留列的值 |
| R2 过滤下推入内连接 | 合取项只引用单侧列（按侧拆分） | 3VL 下 AND 为 TRUE 当且仅当各项均 TRUE |
| R3 过滤下推入左外连接保留侧 | 合取项只引用左侧列 | 左外连接保留全部左行，过滤先后不影响行集 |
| R4 左外连接 → 内连接 | 过滤谓词对右侧列**拒绝 NULL**（语法可判定，保守充分） | 补 NULL 行必被过滤 |
| R5 内连接交换律 | 无条件（输出列序用投影恢复） | 行对集合与顺序无关 |
| R6 恒等投影消除 | 投影列与子模式完全一致（含顺序） | 恒等映射 |
| R7 级联投影合并 | 外层列 ⊆ 内层列 | 连续投影取最终列集 |
| R8 级联过滤合并 | 无条件 | 两次过滤 ≡ 合取一次过滤 |

R4 的“拒绝 NULL”判定（`isNullRejecting`）：比较引用 nullable 侧列 ⇒ 该列 NULL 时比较为
`UNKNOWN`（非 TRUE）；合取中任一分支拒绝 NULL 则整体拒绝；`NOT (x IS NULL)` 在 x 为 NULL
时为 FALSE。判定保守：可能漏判，绝不误判。

优化器（`src/optimize.ts`）自底向上应用 R1–R4、R6–R8 至不动点（有界迭代）；R5 交换律
不自动应用（避免震荡），按需调用。

## 小表穷举核对（`test/exhaustive.test.ts`）

值域 `{NULL, 0, 1}`、两列、行数 0–2（每侧 91 张表；单表规则用行数 0–3 共 820 张），
对每条规则穷举全部表组合，逐例断言：

1. 证书 `applied=true` 且所有前置条件成立（只执行经证明合法的规则）；
2. 重写前后结果**值与重复行**完全一致（多重集相等）。

另含反例测试（`test/rules.test.ts`）：演示缺失前置条件时重写确实不等价
（外连接转内连接、向 nullable 侧下推过滤），证明前置条件的必要性。

## 使用

```bash
npm test    # 编译 + 运行全部测试
npm run demo  # 打印一次端到端优化的重写证书链
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# tests 3（文件）/ 24（用例）
# pass 3 / fail 0
穷举核对用例数（全部通过）：
  R1 过滤下推穿过投影        1,640
  R2 过滤下推入内连接       24,843
  R3 过滤下推入 LOJ 保留侧   8,281
  R4 LOJ → 内连接           16,562
  R5 内连接交换律            8,281
  R6/R7/R8 投影与过滤合并    2,460
  优化器端到端               8,281
  合计                      70,348
```

`npm run demo` 输出（查询 `SELECT * FROM L LEFT JOIN R ON b=c WHERE a=0 AND d=1`）：

```
原查询:   (filter (a = 0 AND d = 1) (left-join b = c (scan L) (scan R)))
优化后:   (inner-join b = c (filter a = 0 (scan L)) (filter d = 1 (scan R)))
结果等价: true
证书链: filter-pushdown-into-left-join-preserved-side
        → left-join-to-inner-join（前置: d=1 拒绝右侧 NULL）
        → filter-pushdown-into-inner-join
```
