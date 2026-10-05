# split-ledger

按有理权重把整数金额拆成整数份额的分账库（TypeScript，仅 Node.js 内置库）。

## 功能

- **核心分账**（`src/split.ts`）：`split(total, recipients)` 把整数 `total`
  按比例权重拆成整数份额，每个接收人有 `[min, max]` 上下限。
  - 权重支持整数、小数（按十进制精确解析）与 `{num, den}` 有理数，内部用
    BigInt 通分，偏差计算完全精确。
  - 目标：精确平方偏差 `Σ (x_i − total·w_i/W)²` 最小；并列时按 ID 升序。
  - 实现为单位贪心边际成本分配，对该可分离严格凸目标是最优的，行为上等价于
    “最大余数先分、饱和（达到 max）者退出、相同余数按 ID”。
  - 权重 0 且下限非零合法（先填下限）；`Σmin > total` 或 `Σmax < total`
    时抛 `InfeasibleError`。
- **多订单账本**（`src/ledger.ts`）：`SplitLedger` 跨多个订单累计分账，
  每个接收人有全局上下限。
  - `addOrder` / `refund` 后对所有未锁定接收人按剩余活跃订单总额重新分配；
    退款即撤销该订单贡献并重分其余未锁订单。
  - `lock(id)` 冻结某接收人当前累计金额，之后加单/退款均不动锁定金额；
    `unlock(id)` 重新加入 pooled 分配。
  - 任何导致约束不可满足的操作抛 `InfeasibleError` 并回滚，账本状态不变。

## 用法

```ts
import { split, SplitLedger } from "./src/index.js";

split(100, [
  { id: "a", weight: { num: 1, den: 3 } },
  { id: "b", weight: 0.5 },
  { id: "c", weight: 1, min: 10, max: 40 },
]);

const ledger = new SplitLedger([
  { id: "a", weight: 1 },
  { id: "b", weight: 1 },
  { id: "c", weight: 2, min: 5, max: 40 },
]);
ledger.addOrder("o1", 60);
ledger.addOrder("o2", 40);
ledger.lock("b");        // 冻结 b 的累计金额
ledger.refund("o1");     // 撤销 o1，重分剩余未锁订单，b 不动
```

## 测试

```
npm test    # tsc 编译 + node --test（Node 内置 test runner，无外部依赖）
```

核对方式：

- **小金额全枚举**（`test/enumeration.test.ts`）：400 组随机用例
  （1–4 人、总额 0–12、随机整数权重/上下限，含权重 0），对每个可行用例
  枚举**所有**满足上下限且守恒的分配，验证库输出的精确平方偏差等于枚举最小值、
  总额守恒、上下限满足、结果确定；不可行用例验证抛 `InfeasibleError`。
- **8 人 / 100 分全枚举**：随机 8 接收人、总额 100，用中途相遇法
  （4+4 两半各按部分和记录最小代价再合并，目标函数按接收人可分离，故精确）
  枚举全部分配，核对最优性与守恒。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

✔ core split (15 tests)
  ✔ equal weights, remainder ties broken by ID order
  ✔ proportional integer weights
  ✔ exact rational weights 1/3 : 1/2 : 1/6
  ✔ decimal number weights are parsed exactly
  ✔ weight 0 with non-zero min is legal and gets exactly its min
  ✔ saturated recipient exits, remainder redistributed
  ✔ min bounds are filled before proportional distribution
  ✔ all-zero weights fall back to ID order
  ✔ numeric IDs tie-break numerically
  ✔ infeasible: sum of minimums exceeds total
  ✔ infeasible: sum of maximums below total
  ✔ duplicate recipient IDs are rejected
  ✔ negative weights are rejected
  ✔ exact squared deviation is computed with BigInt rationals
  ✔ splitDetailed returns entries sorted by ID and conserving total
✔ multi-order ledger (9 tests)
  ✔ allocation accumulates across orders and matches a fresh split
  ✔ global bounds hold across orders
  ✔ refund undoes the order and re-splits the rest
  ✔ locked amounts do not move across refunds
  ✔ refund that would strand a locked amount fails and rolls back
  ✔ addOrder that exceeds global maxima fails and rolls back
  ✔ unlock re-joins the recipient to the pooled split
  ✔ weight 0 with global min is honored across orders
  ✔ unknown order refund and double lock are rejected
✔ exhaustive-enumeration cross-check (2 tests)
  ✔ small amounts: split matches full enumeration (min deviation + conservation)
  ✔ 8 recipients, 100 cents: split matches meet-in-the-middle full enumeration

# tests 26  # pass 26  # fail 0
```
