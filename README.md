# coupon-optimizer

优惠库优化器：至多 18 张券、8 个订单，支持有向前置（prereq）、互斥组、
跨订单共享券、已结算订单锁定与退款重算。仅使用 TypeScript + Node.js
内置库，零运行时依赖。

## 语义

- **券作用顺序**：每个订单上的券按输入序依次作用于整数分金额。
- **百分比向下取整**：`amount - floor(amount * pct / 100)`；立减券
  `max(0, amount - value)`。
- **有向前置**：券 B 声明 `prereq: 'A'` 时，B 在某订单可用当且仅当 A
  也用于该订单（按订单判定）。
- **互斥组**：同一 `mutexGroup` 的券不能用于同一订单（不同订单可各用一张）。
- **共享券**：`shared: true` 的券可同时属于多个订单；普通券至多属于一个订单。
- **选优规则**：总实付最低 → 券使用次数最少 → 所有权向量按输入序字典序最小
  （单订单场景等价于：实付最低 → 券数最少 → 排序后 ID 序列最小）。
- **已结算锁定**：`settle(orderId)` 按最近一次求解结果锁定该订单实付；
  之后任何重算（含退款）都必须使锁定订单的实付精确等于锁定值，否则不可行。
- **退款**：`refund(couponIds)` 撤销券并对剩余券重新分配；未锁订单重新优化，
  锁定订单实付不变。

## 求解与搜索预算

- 单订单（未锁定）：枚举全部合法子集（至多 2^18 = 262144），必然已证最优。
- 多订单：按输入序对券做 DFS 分支定界（普通券分支：不用/各订单；共享券分支：
  订单的所有子集）。`maxNodes` 为搜索预算：
  - 预算内搜完 → `status: 'optimal'`，`provenOptimal: true`（已证最优）；
  - 预算耗尽 → `status: 'feasible'`，`provenOptimal: false`，返回当前最优可行解；
  - 锁定约束无法满足 → `status: 'infeasible'`。
- 输出每券所有权（`ownership: couponId -> orderId[]`）与逐单金额
  （`orderAmounts`），以及 `total`、`nodesExplored`、`budgetExhausted`。

## 独立核对

`src/brute.ts` 是无剪枝、无预算的独立暴力枚举器，逐叶重建每单券列表重算金额；
`test/crosscheck.test.ts` 用确定性随机小实例（含共享券、前置、互斥、锁定）
交叉验证主求解器与暴力枚举结果完全一致。

## 使用

```bash
npm test          # tsc 编译 + node --test 运行全部测试
npm run build     # 仅编译到 dist/
```

```ts
import { CouponEngine } from './src';

const e = new CouponEngine();
e.addOrder('o1', 1000);            // 整数分
e.addOrder('o2', 2000);
e.addCoupon({ id: 'p50', kind: 'percent', value: 50 });
e.addCoupon({ id: 'a300', kind: 'amount', value: 300, mutexGroup: 'g' });
e.addCoupon({ id: 'ship', kind: 'amount', value: 100, shared: true });

const r = e.solve(2_000_000);      // 搜索预算（节点数）
// r.ownership: 每券所有权；r.orderAmounts: 逐单金额；r.status / r.provenOptimal

e.settle('o2');                    // 锁定 o2 实付
const after = e.refund(['a300']);  // 撤销 a300 并重算
```

## 结构

- `src/types.ts` — 公共类型
- `src/apply.ts` — 券作用与单子集合法性（纯函数）
- `src/single.ts` — 单订单全子集枚举
- `src/solver.ts` — 多订单预算 DFS 分支定界
- `src/brute.ts` — 独立暴力枚举核对器
- `src/engine.ts` — 状态外观：加券/加单/求解/结算/退款
- `test/` — node:test 测试（`shims.d.ts` 为 node 内置模块的最小类型声明）
