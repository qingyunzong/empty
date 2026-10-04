# weighted-fair-allocator

整数需求的加权最大最小公平分摊库（TypeScript + Node.js 内置库，无运行时依赖）。

## 功能

- **逐轮加权最大最小公平分摊**：每轮对未饱和用户按 `rate = 剩余容量 / 活跃权重和`
  计算分数份额 `rate × weight`，向下取整后受需求与每户上限（cap）钳制；
  被钳制的用户饱和退出，释放的容量进入下一轮。
- **余数按 ID**：一轮无人饱和时，取整余数（小于活跃用户数）按用户 ID 升序逐单位分配。
- **需求撤销重新分摊**：`FairAllocator.revokeDemand(id)` 将需求清零并从头重新分摊，
  释放的容量自动再分配。
- **饱和轮次与分数证据**：`AllocationResult.rounds` 记录每轮的精确分数速率
  （`Fraction`，bigint 有理数）、每户分数份额、取整授予量、饱和原因
  （demand/cap）及余数去向；`formatReport()` 输出可读报告。
- **逐单位小容量模型对照**：`allocateByUnit()` 每单位授予 `allocated/weight`
  最小（并列取 ID 小者）的用户，作为参照模型与批量算法交叉验证。

## 使用

```bash
npm test     # tsc 编译到 dist/ 后运行 node:test 套件
npm run demo # 打印饱和轮次、分数证据与逐单位模型对照
```

```ts
import { allocate, FairAllocator, allocateByUnit, formatReport } from "./src/index.js";

const result = allocate(
  [
    { id: "alpha", demand: 9, weight: 2 },
    { id: "beta", demand: 6, weight: 1, cap: 4 },
    { id: "gamma", demand: 8, weight: 1 },
  ],
  13,
);
console.log(formatReport(result));

const allocator = new FairAllocator(13);
// ...addUser(...) 后
const after = allocator.revokeDemand("beta"); // 撤销需求并重新分摊
```

## 两种取整策略的对照结论

批量算法（向下取整 + 余数按 ID）与逐单位贪心在大多数场景一致，但属于不同的
整数取整策略：逐单位模型严格均衡 `allocated/weight`，批量模型把每轮余数固定给
ID 小者。随机小容量对照（容量 ≤ 30，2–5 户，含 cap）实测：500 例中 395 例完全
一致，单户最大偏差为 2。两者共同遵守的不变量（测试断言）：总分摊量均等于
`min(容量, Σ min(需求, cap))`，且均不突破每户需求与上限。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
cross-check: 395/500 trials identical, max per-user diff 2
ok 1 - fraction arithmetic stays exact
ok 2 - weighted split with remainder dealt by ascending ID
ok 3 - weights 2:1 split capacity 10 as 7:3 with remainder by ID
ok 4 - demand saturation frees capacity for later rounds
ok 5 - per-user cap binds before demand
ok 6 - capacity beyond total demand leaves everyone fully satisfied
ok 7 - zero capacity allocates nothing and records no rounds
ok 8 - demand revocation triggers full re-allocation
ok 9 - report exposes saturated rounds and fractional evidence
ok 10 - batch allocator cross-checked against per-unit model on randomized small capacities
ok 11 - re-allocation after revocation stays consistent with per-unit model
# tests 11
# pass 11
# fail 0
```

`npm run demo` 实际输出（容量 13，含撤销 beta 后重新分摊）：

```
=== initial allocation (capacity 13) ===
capacity=13 allocated=13
round 1: capacity=13 weightSum=4 rate=13/4
  user alpha: ideal=13/2 granted=6 residual=9
  user beta: ideal=13/4 granted=3 residual=4
  user gamma: ideal=13/4 granted=3 residual=8
  remainder by ID: alpha+1
saturation order: (none)
final: alpha=7 beta=3 gamma=3

=== per-unit reference model ===
unit-model: alpha=7 beta=3 gamma=3

=== revoke demand of beta and re-allocate ===
capacity=13 allocated=13
round 1: capacity=13 weightSum=3 rate=13/3
  user alpha: ideal=26/3 granted=8 residual=9 SATURATED(demand)
  user gamma: ideal=13/3 granted=4 residual=8
  remainder by ID: alpha+1
saturation order: alpha@r1
final: alpha=9 beta=0 gamma=4
```

## 目录

- `src/fraction.ts` — bigint 精确分数（分数证据）
- `src/allocator.ts` — 逐轮分摊、`FairAllocator`（撤销重分摊）、报告格式化
- `src/unitModel.ts` — 逐单位参照模型
- `test/allocator.test.ts` — 11 个 node:test 用例（含 500+200 例随机对照）
- `types/node-shims.d.ts` — node:test / node:assert 最小类型声明（环境无 @types/node）
