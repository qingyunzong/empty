# split-ledger

按有理权重把整数金额拆成整数份额的分账库（TypeScript，仅依赖 Node.js 内置模块）。

## 特性

- **单次拆分 `split(total, recipients)`**
  - 有理权重 `{num, den}`，内部通分为整数，全程 BigInt 精确计算。
  - 每接收人有上下限 `[min, max]`；先满足下限，再按**最大余数法**分配剩余，
    达到上限者退出分配，余数相同按 ID 升序优先。
  - 目标：精确平方偏差 `Σ(aᵢ − tᵢ)²`（`tᵢ = total·wᵢ/W`）最小；并列最优按
    ID 升序取字典序最大者。
  - 权重 0 且下限非零合法（该接收人恰好拿下限，除非被迫吸收剩余）；
    全部权重为 0 时退化为尽量均分。
  - 不可行（`Σmin > total` 或 `Σmax < total`）抛出 `SplitError`（`code: "INFEASIBLE"`）。
- **多订单账本 `SplitLedger`**
  - 分账跨多个订单：把全部未退款订单的总额作为整体，按全局权重与全局
    上下限一次性最优分配。
  - `refund(orderId)`：撤销该订单金额，重新分配其余未退款订单。
  - `lock(recipientId)`：锁定金额不动，后续加单/退款/重算均不改变；
    `unlock` 后重新参与分配。
  - 重算不可行时操作回滚并抛错，账本保持原状。

## 用法

```ts
import { split, SplitLedger } from "./src/index.js";

split(100, [
  { id: "a", weight: { num: 1, den: 2 }, min: 0, max: 100 },
  { id: "b", weight: { num: 1, den: 3 }, min: 0, max: 100 },
  { id: "c", weight: { num: 1, den: 6 }, min: 0, max: 100 },
]);
// => Map { "a" => 50, "b" => 33, "c" => 17 }

const ledger = new SplitLedger([...]);
ledger.addOrder("o1", 60);
ledger.addOrder("o2", 40);
ledger.lock("a");        // 冻结 a 当前份额
ledger.refund("o1");     // 撤销 o1，重算其余订单；a 不动
ledger.allocations();    // => { a: ..., b: ..., c: ... }
```

## 算法说明

从下限出发，逐批把每一分分给亏空 `tᵢ − aᵢ` 最大的未饱和接收人（即可分凸
目标的单位增量贪心，Ibaraki–Katoh，精确最优）；同一接收人在严格保持最大
亏空期间可一次批量补足。并列按 ID 升序裁决。复杂度约 `O(n²)` 个批量轮次，
与总额大小基本无关。

## 测试

```
npm test
```

测试用两个相互独立的核对器验证最优性与守恒性：

- `bruteForce`：字面全枚举所有可行分配（小规模）。
- `dpSolve`：按接收人×总额的精确动态规划（等价于全枚举，覆盖 8 人/100 分）。

两者均以 BigInt 计算精确平方偏差，并列取 ID 升序字典序最大，与 `split()`
的输出逐项比对；同时断言总额守恒与上下限。

## 实际测试结果（2026-10-05，Node v22.22.1）

```
ok 1 - dist/test/enumeration.test.js
ok 2 - dist/test/ledger.test.js
ok 3 - dist/test/split.test.js
# tests 3
# pass 3
# fail 0
```

共 25 个子测试全部通过，其中枚举核对规模：

- 2 人全参数网格（权重/上下限/总额全组合）vs 暴力枚举：**128,304** 个实例
- 3–4 人随机实例 vs 暴力枚举：**4,000** 个实例
- 5–8 人、总额 100 分 vs 精确 DP：**599** 个实例
- 1–8 人、随机总额 0..100 vs 精确 DP：**800** 个实例
- 不可行实例与枚举器一致地抛出 `INFEASIBLE`（2,000 组变异参数）

所有实例均满足：总额守恒、上下限约束、平方偏差最小、并列按 ID 字典序最大。
