# 库存规划 CLI（inv-planner）

TypeScript + Node.js 内置库实现，零外部依赖。在「至多 12 天需求、提前期、独立仓容」
约束下决定**整数下单量**，目标为**最低总费用 = 固定启单费 + 持有费**；
**禁止缺货**，**到货发生在当日需求之前**。

## 模型假设

- 规划期 `horizon` 为 1..12 天；逐日需求为非负整数。
- 每仓容量独立、需求独立，逐仓分别求最优后汇总（`solveScenario`）。
- 每个仓库可有多个下单渠道（如标准 / 加急），渠道区别在**提前期**与**固定启单费**；
  同一到货日同一渠道只下一单，订单量为整数。
- 到货当日即可用于满足当日需求（到货在日需求前）；期末库存 ≤ 仓容且 ≥ 0（禁止缺货）。
- 持有费按每日期末库存计。

## 求解与核对

- `src/solver.ts`：后向动态规划，状态 = (当日, 期初库存)，决策 = 当日各渠道到货量。
- `src/verify.ts`：
  - `dijkstraOptimum` —— **独立有限状态搜索**（显式状态图 + 前向 Dijkstra，字典序权重），核对 DP 最优值；
  - `enumerateOptimum` —— **短周期枚举对照**（无记忆化纯递归枚举全部可行计划）；
  - `checkCertificate` —— 逐日守恒 / 仓容 / 无缺货 / 锁定与在途约束 / 费用重算。
- CLI 输出**逐日库存证书**（期初、到货、需求、期末、持有费、守恒标记）并附三方核对结果。

## 重规划（需求更正）

- 已公布订单是调整基准；其中**锁定部分不可撤销**，仅未锁定部分可撤；
  下单日落在规划窗口之前的**在途订单只能撤、不能增量**。
- 目标为字典序：**先最少改已公布下单量**（Σ|新量 − 已公布|），**再总费用少**。
- 输出**重规划净差**：逐槽位「已公布 → 新计划」、调整量 |Δ| 合计、
  旧方案在更正需求下的费用对照，以及新方案的**逐日守恒**序列。

## 用法

```bash
npm run build                              # tsc 编译到 dist/
node dist/src/cli.js plan   examples/plan.json
node dist/src/cli.js replan examples/replan.json
node dist/src/cli.js verify examples/replan.json
```

退出码：0 正常；1 用法或输入错误；2 不可行（仓容/提前期下无法满足需求且禁止缺货）。

场景 JSON 字段见 `src/types.ts` 与 `examples/`：`horizon`、`warehouses[]`
（`capacity`、`initialInventory`、`holdingCost`、`demand[]`、`channels[]`
（`leadTime`、`fixedCost`）、重规划时的 `published[]`（`qty`、`locked`））。

## 测试（实际运行结果）

`npm test` = `tsc -p tsconfig.json && node dist/test/*.test.js`，
共 3 个测试文件、18 个用例，全部通过：

```
# tests 3        (solver.test.js 7 例 / replan.test.js 7 例 / verify.test.js 4 例)
# pass 3
# fail 0
```

覆盖内容：

- DP 与短周期枚举对照：120 个随机新计划场景 + 80 个随机重规划场景，最优值一致；
- DP 与独立有限状态搜索对照：60 个新计划 + 50 个重规划随机场景（含 12 天期），一致；
- 字典序目标：需求下调时保持已公布量（偏差 0）优先于降低费用；
- 锁定不可撤销、仓容迫使撤销未锁定部分、在途订单不可增量；
- 禁止缺货的不可行判定、加急渠道选用、整数下单、多仓独立求解；
- 证书篡改（破坏守恒 / 订单不符 / 费用虚报）可被 `checkCertificate` 检出；
- CLI 端到端：`plan` / `replan` / `verify` 的退出码与关键输出。

示例实际结果：`examples/plan.json` 两仓总费用 276（WH-A 154 + WH-B 122）；
`examples/replan.json` 重规划总费用 286，WH-A 偏差 2、WH-B 偏差 1，
均通过逐日守恒、证书校验与独立有限状态搜索核对。
