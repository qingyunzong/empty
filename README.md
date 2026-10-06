# 采购下单优化 CLI

在不超过 8 家供应商处按整数数量下单，最小化总采购成本，并满足总量、合同与分时段配送约束。

## 问题定义

- **下单数量**：每家供应商为 `0`（不订）或 `[minQty, maxQty]` 内整数，`maxQty ≤ 80`。
- **全量阶梯单价**：订单总量落入某档位时，整单按该档单价计价（非分段累计）。
- **总量约束**：`demand ≤ 总下单量 ≤ cap`。
- **目标序**：总价最小 → 超购量（总量 − demand）最小 → 数量向量字典序最小。
- **合同约束**：二元互斥（两家不可同时下单）与二元依赖（向 a 下单必须也向 b 下单）。
- **配送约束**：每家供应商有到货时段；各时段所有供应商到货量之和不超过该时段共享容量；
  且逐时段累计到货 ≥ 累计需求（无缺货），输出逐时段缺货验证报告。

## 算法

- **联合 DP**（`solveDp`）：按到货时段分组、再按供应商转移；状态为
  `(下单掩码, 各时段到货量)`，编码为数值键（总量 = 各时段到货量之和，存于条目内）。
  同状态仅保留 `(成本, 数量向量字典序)` 最优前缀；每处理完一个时段即按
  “累计到货 ≥ 累计需求” 剪枝。最终在满足合同约束的状态中按目标序取最优。
- **枚举核验**（`solveEnumerate`）：与 DP 完全相同的约束与目标序的暴力枚举，
  用于小例对照（`--verify`，以及测试中的 300 例随机对照）。

## 使用

```bash
npm test                      # 编译并运行全部测试
node dist/src/cli.js example.json            # 求解
node dist/src/cli.js example.json --verify   # 求解并与枚举核验
cat example.json | node dist/src/cli.js -    # 从 stdin 读取
```

退出码：`0` 可行；`1` 无可行解；`2` DP 与枚举不一致。

## 输入格式

```json
{
  "demand": 100, "cap": 110,
  "suppliers": [
    { "id": "A", "minQty": 20, "maxQty": 80, "arrivalSlot": 0,
      "tiers": [ { "upTo": 40, "unitPrice": 10 }, { "upTo": 80, "unitPrice": 8 } ] }
  ],
  "exclusions": [[0, 1]],
  "dependencies": [[3, 2]],
  "slotCapacity": [70, 60],
  "slotDemand": [50, 55]
}
```

`exclusions`/`dependencies` 使用供应商下标；`maxQty` 缺省为 80；
`tiers` 的 `upTo` 严格递增且末档须覆盖 `maxQty`。

## 输出

`quantities`（按供应商 id）、`vector`、`totalQty`、`overPurchase`、`totalCost`，
以及 `slots` 逐时段验证（到货量、容量、累计到货、累计需求、缺货量、是否通过）。

## 环境说明

零运行时依赖；TypeScript 由全局 `tsc` 编译。沙箱禁止子进程，
测试通过进程内微型运行器（`test/harness.ts`）执行，CLI 以 `runCli` 函数做端到端测试。
