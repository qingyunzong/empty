# 采购优化 CLI（procure-cli）

按供应商整数数量采购，支持**阶梯全量单价**、**运费门槛**、**起订量**约束；
在**采购总量恰等于需求**的前提下，求**总费用（整数分）最小**，费用相同则**使用供应商数量最少**。

- 规模：最多 6 家供应商，默认总需求 200（可用 `--demand` 调整）
- 实现：TypeScript，仅使用 Node.js 内置库（`node:test` / `node:assert` / `node:fs` / `node:util`），无第三方依赖
- 求解：动态规划（精确最优）；另提供全枚举求解器用于小需求验收

## 语义约定

- **整数数量**：每家供应商的采购数量为非负整数，所有供应商数量之和**恰等于**需求。
- **阶梯全量单价**：购买 `q` 件时，取 `minQty <= q` 的最高档位单价，`q` 件**全部**按该单价计（非分段累计）。
- **运费门槛**：该供应商商品金额（不含运费）`>= freeAboveCents` 免运费，否则收 `feeCents`；不采购（数量为 0）不产生任何费用。
- **起订量**：要么不买（0），要么 `>= moq`。
- **整数分**：所有金额（单价、运费、门槛）均以整数分表示与计算。
- **目标**：总费用最小；并列时供应商数量最少。

## 使用

```bash
npm run build                                  # 编译 TypeScript 到 dist/
node dist/src/cli.js --demand 200 --suppliers examples/suppliers.json
cat examples/suppliers.json | node dist/src/cli.js          # 缺省从 stdin 读配置，缺省需求 200
node dist/src/cli.js --demand 20 --enumerate < examples/suppliers.json  # 全枚举（仅小需求）
```

退出码：`0` 已求得最优解；`1` 参数或配置错误；`2` 无可行方案（如需求小于唯一起订量）。

### 供应商配置格式

```json
{
  "suppliers": [
    {
      "id": "A",
      "moq": 1,
      "tiers": [{ "minQty": 1, "unitPriceCents": 520 }, { "minQty": 100, "unitPriceCents": 480 }],
      "shipping": { "freeAboveCents": 50000, "feeCents": 900 }
    }
  ]
}
```

校验规则：1–6 家供应商；`moq >= 1`；`tiers` 按 `minQty` 升序且首档 `minQty <= moq`；所有金额为 `>= 0` 的整数（分）。

## 算法

- **DP（默认）**：`dp[d]` 为已处理供应商恰好凑够 `d` 件的最优 `(费用, 供应商数)`，按字典序比较；
  逐家供应商做完全背包式转移（可选数量为 `0` 或 `>= moq`），并记录路径回溯方案。
  复杂度 `O(供应商数 × demand²)`，6 家 × 200 需求约 24 万次转移。
- **全枚举（验收）**：递归枚举每家数量（`0` 或 `>= moq`），仅保留总和恰等需求的组合取最优；
  需求上限 60（`ENUMERATION_MAX_DEMAND`），仅用于小需求下交叉验收 DP 结果。

## 测试

```bash
npm test    # = tsc -p tsconfig.json && node --test dist/test/solve.test.js dist/test/cli.test.js
```

覆盖：阶梯全量计价、运费门槛边界、起订量可行性、数量恰等需求（含不可行）、手算最优、
同费用取更少供应商、**DP 与全枚举在 300 组随机小需求（0–18）下结果一致**、配置校验、CLI 端到端。

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
> procure-cli@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/solve.test.js dist/test/cli.test.js

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
# Subtest: dist/test/solve.test.js
ok 2 - dist/test/solve.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms 399.374165
```

逐条用例（直接运行编译后测试文件，同一份 `node:test` 断言）：**15 项全部通过**——

```
solve.test.js: 9/9 pass
  ok 1 阶梯全量单价：达到档位后全部数量按该档单价计
  ok 2 运费门槛：商品金额达到门槛免运费，否则收运费
  ok 3 起订量：0 或 >= moq 可行，其余不可行
  ok 4 数量恰等需求：无法满足时返回不可行
  ok 5 需求为 0：不采购，费用 0，供应商数 0
  ok 6 手算最优：运费与阶梯共同影响
  ok 7 费用相同则供应商数量更少者胜
  ok 8 DP 与全枚举在小需求下结果一致（随机配置验收）
  ok 9 配置校验：最多 6 家供应商、金额为整数分
cli.test.js: 6/6 pass
  ok 1 CLI：6 家供应商、总需求 200，输出与求解器一致
  ok 2 CLI：缺省 --suppliers 时从标准输入读取，缺省需求为 200
  ok 3 CLI：--enumerate 小需求与 DP 结果一致
  ok 4 CLI：无可行方案时退出码为 2
  ok 5 CLI：非法需求与非法配置退出码为 1
  ok 6 CLI：--help 输出用法
```

示例（`examples/suppliers.json`，6 家供应商，需求 200）实际输出：最优 **88995 分，2 家供应商**
（B 179 件 × 435 分 = 77865 分免运费；D 21 件 × 530 分 = 11130 分；B 满 180 件会跳入 490 分档，故停在 179）：

```json
{
  "feasible": true,
  "demand": 200,
  "totalCents": 88995,
  "supplierCount": 2,
  "allocations": [
    { "supplierId": "B", "qty": 179, "unitPriceCents": 435, "goodsCents": 77865, "shippingCents": 0, "totalCents": 77865 },
    { "supplierId": "D", "qty": 21,  "unitPriceCents": 530, "goodsCents": 11130, "shippingCents": 0, "totalCents": 11130 }
  ]
}
```
