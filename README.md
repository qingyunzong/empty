# qopt — 可证明合法的查询重写库（NULL 三值逻辑）

TypeScript 实现，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零 npm 运行时依赖。
所有数据采用 SQL **bag（多重集）语义**：重复行被保留并参与等价性核对。

## 功能

- **NULL 三值逻辑（3VL）执行器**：`TRUE / FALSE / UNKNOWN`，`NULL` 参与的比较恒为
  `UNKNOWN`；`Filter` 只保留谓词为 `TRUE` 的行（`src/values.ts`, `src/expr.ts`, `src/plan.ts`）。
- **过滤下推**（`filter-pushdown-into-join`）：按连接词分解谓词，仅当下列**公开前置条件**
  全部满足才下推，否则拒绝或保留残余过滤：
  - `P0` 若某连接词只引用 NULL 供给侧且对该侧 **NULL 拒绝**（null-rejecting），
    先将连接种类强化（left/right→inner，full→left/right/inner）——否则被保留行会
    在下推后"复活"，这是本库修复过的真实健全性陷阱；
  - `P1` 连接词引用列 ⊆ 目标侧模式；
  - `P2` 推入 NULL 供给侧时谓词必须 NULL 拒绝（在 全NULL 行上求值不为 `TRUE`，
    对本表达式语言是精确判定）。
- **投影消除**：恒等投影消除（`project-elimination-identity`）与嵌套投影合并
  （`project-elimination-nested`，前置条件：外层列 ⊆ 内层列）。
- **内外连接重写**：外连接 + NULL 拒绝过滤 ⇒ 内连接（`outer-to-inner-join`）；
  内连接交换律（`join-commutativity-inner`，仅 inner，带列序恢复投影）；
  left/right 镜像互换（`left-right-join-swap`）。
- **重写证书**：每条规则触发时返回 `Certificate`（`src/rules.ts`），包含规则名、
  逐条已检查前置条件（含具体证据，如引用列集合、NULL 拒绝判定结果）及重写前后
  计划指纹。优化器 `optimize()`（`src/optimize.ts`）做自底向上不动点重写并输出完整证书链。
- **小表穷举核对**（`src/verify.ts`）：枚举定义域 `{NULL,0,1}` 上 0..2 行的全部
  多重集表（每表 55 种，两表共 3025 种组合），逐组合执行原查询与重写查询，
  按 bag 语义比较**值与重复行数**。负面对照测试证明核对器能发现非法重写
  （如把 `IS NULL` 推入 left join 的 NULL 供给侧、外连接交换）。

## 使用

```bash
npm test   # tsc 编译 + node --test（需要环境中有 tsc，本项目无其他依赖）
```

```ts
import { table, scan, filter, join, and, gt, col, lit, optimize } from "./src/index.js";

const R = table(["a", "b"], [[1, 10], [2, null], [2, null]]);
const S = table(["c", "d"], [[1, 100], [3, 300]]);
const q = filter(and(gt(col("a"), lit(0)), gt(col("d"), lit(50))),
                 join("left", /* a = c */ { kind: "cmp", op: "=", left: col("a"), right: col("c") }, scan(R), scan(S)));
const { plan, certificates } = optimize(q);
// certificates: filter-pushdown-into-join（P0 强化 left→inner + P1 双侧下推）
```

## 实际测试结果（2026-10-07，Node v22.22.1，tsc 7.0.2）

`npm test` 实际输出（27 个测试全部通过）：

```
ok 1 - dist/test/executor.test.js    # 6 个：bag 语义 / 3VL 过滤 / 各类连接执行
ok 2 - dist/test/logic.test.js       # 4 个：3VL 真值表 / NULL 比较 / IS NULL
ok 3 - dist/test/rules.test.js       # 8 个：规则触发、证书内容、非法情形拒绝
ok 4 - dist/test/verify.test.js      # 9 个：3025 组合穷举等价 + 负面对照
# tests 4
# pass 4
# fail 0
# duration_ms ~1600-2900
```

穷举核对覆盖：内连接过滤下推、NULL 拒绝谓词推入 left join NULL 供给侧（含种类强化）、
外连接转内连接、投影消除（恒等 + 嵌套）、内连接交换律、left/right 镜像、
full join 双侧 NULL 拒绝收敛 inner、优化器全链路（各 3025 种表组合，值与重复行完全一致）；
两个负面对照确认非法重写必被穷举核对器以反例拒绝。
