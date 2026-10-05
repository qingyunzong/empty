# inventory-planner

库存规划 CLI：按至多 12 天需求、提前期与仓容决定**整数下单量**，成本含**固定启单费**与**持有费**；
**禁止缺货**，到货发生在当日需求之前。每仓容量相互独立，逐仓独立求解。仅使用 TypeScript +
Node.js 内置库（无第三方依赖）。

## 构建与测试

```bash
npm run build   # tsc 编译到 dist/
npm test        # 编译并运行 node:test 测试（21 项）
```

## 命令

```bash
node dist/src/cli.js plan <scenario.json> [--json]        # 最优整数下单 + 逐日库存证书
node dist/src/cli.js verify <scenario.json>               # DP vs 独立有限状态搜索核对
node dist/src/cli.js crosscheck <scenario.json>           # DP vs 短周期暴力枚举对照
node dist/src/cli.js replan <replan.json> [--json]        # 需求更正后的重规划
```

## 模型

- 天数 0..H-1，`horizon ≤ 12`；所有数量与费用均为非负整数。
- 第 t 天：期初库存 + 当日到货（普通/加急两流）− 当日需求 = 期末库存；期末库存 ∈ [0, capacity]。
- 普通流：提前期 `leadTime`、固定费 `fixedOrderCost`、可选单位费 `unitCost`；
  加急流（可选）：更短提前期、独立固定费/单位费。下单日 p 的订单在 p+lead 日需求前到货。
- 持有费按期末库存逐日计。`pipeline` 为已承诺到货（费用沉没、不可改）。
- 目标：总费用最小（重规划时为字典序：先最少改已公布下单量，再总费用最小）。

### scenario.json

```json
{
  "horizon": 12,
  "warehouses": [{
    "id": "W1", "capacity": 60, "initialInventory": 5,
    "demand": [4, 6, 8, 10, 8, 6, 4, 6, 8, 10, 8, 6],
    "leadTime": 2, "fixedOrderCost": 40, "holdingCost": 1,
    "expedite": { "leadTime": 1, "fixedCost": 55, "unitCost": 1 },
    "pipeline": [{ "arrivalDay": 0, "qty": 5, "stream": "normal" }]
  }]
}
```

### replan.json（需求更正重规划）

```json
{
  "scenario": { "...": "demand 为更正后的全周期需求" },
  "now": 2,
  "lockWindowDays": 2,
  "warehouses": [{
    "id": "W1", "inventoryAtNow": 2,
    "published": [
      { "arrivalDay": 2, "qty": 12 },
      { "arrivalDay": 3, "qty": 14, "lockedQty": 6 }
    ]
  }]
}
```

- 已公布订单仅**未锁定部分可撤**（`lockedQty` 不可撤；未给定时，到货日落在
  `now + lockWindowDays` 之内视为全锁）；`pipeline` 全部锁定。
- 输出：已公布订单改动表（published/locked/new/delta）、新订单、总偏差、
  **重规划净差**（replanned − 保持公布不变的基线费用；基线不可行时为 n/a）、
  **逐日守恒证书**（期初+到货−需求=期末，逐行校验）。

## 正确性核对（三重独立）

1. **后向 DP**（`src/core.ts`）：状态 (日, 库存)，字典序目标 (偏差, 费用)。
2. **独立有限状态搜索**（`src/finitestate.ts`）：前向 Dijkstra 显式状态图最短路，
   与 DP 独立实现，`plan`/`replan` 输出中自动核对决策最优值。
3. **短周期枚举对照**（`src/enumerate.ts`）：小周期暴力枚举全部决策序列，
   `crosscheck` 命令与测试中与 DP 对照。

## 实际测试结果（npm test，Node v22.22.1，tsc 7.0.2）

```
# tests 3  (文件)  # pass 3  # fail 0
21/21 用例通过，包括：
- 手算最优对照（合并下单 vs 分两次下单）
- 加急流在普通提前期来不及的时候被选用
- 缺货不可行识别（DP / 有限状态搜索 / 枚举三者一致）
- 300 组随机用例：DP == 独立有限状态搜索 == 枚举，且决策可模拟复现、守恒证书零错误
- 锁定部分不可撤 / 未锁定部分可撤 / 偏差优先于费用（宁可持有也不改公布量）
- 必须改动公布量时：偏差最小、费用次优（与枚举对照）
- 重规划净差：基线可行时为 0（保公布量），基线不可行时报 null
- 锁窗默认规则、随机重规划用例 DP == 枚举（120 组）
- CLI：plan/verify/crosscheck/replan 输出、--json、错误输入退出码 2
```

示例运行：`node dist/src/cli.js plan examples/basic.json`
（W1 最优 257，W2 最优 78，守恒 OK，有限状态核对 OK）；
`node dist/src/cli.js replan examples/replan.json`（偏差 0，新单 2 笔，基线不可行）。
