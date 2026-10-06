# procure-cli

采购优化 CLI（TypeScript，零运行时依赖）：

- ≤ 8 家供应商、整数下单量（每家 ≤ 80），各家有最低起订量与**全量阶梯单价**（按下单总量所在档位对全部数量计价）；
- 总量须满足需求且不超过上限；目标按字典序：**总价最小 → 超购最少 → 数量向量字典序最小**；
- 合同约束：二元**互斥**（`mutex`）与**依赖**（`depends`：选 i 必须选 j）；
- 配送分时段、容量共享：每笔订单整体排入一个时段，下单量决定各时段到货库存；
- 输出**逐时段缺货验证**（累计到货 vs 累计需求），联合 DP 求最小总缺货；
- 采购 DP 与全量枚举核验对照；排程联合 DP 与小例穷举核验对照。

## 使用

```bash
npm test                                # 编译并运行全部测试（node:test）
npm run cli -- solve examples/sample.json --verify     # 仅采购优化
npm run cli -- schedule <file.json> --verify           # 仅分时段配送
npm run cli -- run examples/sample.json --verify       # 采购 + 排程
node dist/src/cli.js run examples/sample.json --json   # JSON 输出
```

`--verify`：采购用枚举、排程用穷举交叉核验（组合数超过 5,000,000 时自动跳过）。

## 输入格式

```jsonc
{
  "demand": 100,            // 需求总量
  "maxTotal": 120,          // 总量上限
  "suppliers": [            // 1..8 家
    { "name": "A", "minQty": 10, "maxQty": 60,
      "tiers": [ { "upTo": 30, "unitPrice": 5 }, { "upTo": 60, "unitPrice": 4 } ] }
  ],
  "mutex":   [[0, 1]],      // 可选：互斥对（供应商下标）
  "depends": [[2, 3]],      // 可选：选 2 必须同时选 3
  "slots": [                // run/schedule 模式需要
    { "capacity": 50, "demand": 30 }
  ],
  "quantities": [0, 51, 0, 49]   // 仅 schedule 模式：各供应商下单量
}
```

## 算法

- **采购** `src/procurement.ts`：按供应商逐层 DP，状态为 `(已下单供应商位掩码, 累计总量)`，
  值保留该状态下 `(总价, 数量向量)` 的字典序最优；末层在 `总量 ∈ [demand, maxTotal]`
  且掩码满足互斥/依赖的状态中取 `(总价, 超购, 向量)` 最优。
  `enumerateProcurement` 为全量枚举，用于核验。
- **排程** `src/schedule.ts`：有限时段联合 DP，按时段推进，状态为"已排入订单的位掩码"，
  每时段枚举未排订单的子集（受时段容量约束），累计缺货
  `max(0, 累计需求 − 累计到货)` 最小化；平局偏向更早时段。
  `bruteForceSchedule` 为逐订单递归穷举，用于小例核验。

## 结构

```
src/types.ts        类型定义
src/pricing.ts      全量阶梯计价
src/validate.ts     输入校验（≤8 家、数量 ≤80、阶梯递增且覆盖 maxQty 等）
src/procurement.ts  采购 DP + 枚举核验
src/schedule.ts     分时段联合 DP + 穷举核验
src/cli.ts          命令行入口（solve / schedule / run）
test/               node:test 测试（含 200 组采购、300 组排程随机对照）
types/node-shims.d.ts  最小 Node API 类型声明（环境无 @types/node）
```
