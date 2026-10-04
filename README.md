# 优惠库(coupon-library)

TypeScript + Node.js 内置库实现的优惠引擎:单订单最优用券、跨订单共享券分配、
已结算订单锁定与退款重算,并以独立穷举核对小规模分配结果。

## 语义约定

- **规模上限**:至多 18 张券、8 个订单,超出即抛错。
- **整数分**:所有金额为非负整数分;`amount` 券定额减(实付触底为 0),
  `percent` 券按 `floor(金额 * 百分比 / 100)` 向下取整。
- **输入序**:券按输入顺序依次作用于订单金额,顺序不同结果不同。
- **有向前置**:`requires` 指向的前置券必须先在**同一订单**使用;前置关系必须无环。
- **互斥组**:同一 `mutexGroup` 的券不可叠加于同一订单(可拆分至不同订单)。
- **平手规则**:实付最低 → 用券数最少 → ID 序最小
  (单订单为排序后 ID 序列字典序;多订单为所有权向量字典序,闲置排最后)。
- **跨订单共享券**:未声明 `orders` 的券可在任意订单间分配,每张券全局最多用一次;
  声明 `orders` 的券只能落在指定订单。
- **结算锁定**:`settle` 冻结订单实付与用券,后续任何重算都不得改变锁定实付。
- **退款重算**:`refund` 撤销订单(活跃或已结算),其券回到券池,
  未锁订单自动重新分配,其余锁定单实付不变。
- **搜索预算**:`maxNodes` 限制分支定界节点数;预算耗尽返回 `feasible`
  (当前最优可行解,贪心兜底),搜索空间穷尽返回 `optimal`(已证最优)。

## 目录结构

- `src/singleOrder.ts` — 单订单引擎:用券计算、合法性、2^18 子集枚举最优、金额验证
- `src/allocator.ts` — 多订单分配器:分支定界 + 节点预算,输出每券所有权与逐单金额
- `src/session.ts` — `CouponLibrary` 会话:加券/加单、优化、结算锁定、退款重算、报告
- `src/verify.ts` — 独立穷举核对器(≤12 券且 ≤3 订单),与优化器交叉验证
- `test/` — node:test 测试(共 34 个用例)
- `types/node-shim.d.ts` — 离线环境最小 Node 类型声明(仅覆盖测试用到的 API)

## 使用示例

```ts
import { CouponLibrary } from './src/index.js';

const lib = new CouponLibrary();
lib.addCoupon({ id: 'S1', kind: 'percent', value: 50 });          // 跨订单共享券
lib.addCoupon({ id: 'S2', kind: 'percent', value: 50 });
lib.addOrder({ id: 'A', amountCents: 1000 });
lib.addOrder({ id: 'B', amountCents: 1000 });
lib.addOrder({ id: 'C', amountCents: 100 });

lib.optimize();                 // S1->A, S2->B; A=500, B=500, C=100
lib.settle('A');                // 锁定 A:实付 500 冻结
const r = lib.refund('B');      // 退 B:S2 回池并重配到 C
// r.payments: { A: 500, C: 50 }  —— 锁定实付不变
// r.ownership: { S1: 'A', S2: 'C' }
```

## 运行测试

```sh
npm test   # tsc 编译 + node --test(需要 PATH 中有 tsc,Node >= 18)
```

实际测试结果见 [RESULTS.md](./RESULTS.md)。
