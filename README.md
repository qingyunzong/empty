# budget-ledger

层级令牌预算账本（TypeScript + Node.js 内置库，零运行时依赖）。

## 功能

- **父令牌授权子令牌**：`createRoot` 建立预算池，`allocate(parent, child, amount)` 从父令牌剩余额度划拨给子令牌。
- **子消费记父总消费**：`consume(token, amount, consumptionId)` 扣减该令牌剩余额度，并把金额累加到自身及所有祖先的 `totalConsumed`（父/根令牌可见汇总）。
- **退款对应原 ID 且仅一次**：`refund(consumptionId)` 按原消费 ID 恢复额度并回滚祖先总消费；重复退款或未知 ID 抛错。
- **撤销子令牌返还未用额度**：`revoke(token)` 将该令牌及整个子树的未用额度返还父令牌，子树随后不可再操作。
- **批量转账原子性**：`transferBatch([...])` 先整体校验（含同一令牌多笔净额结算），任一失败则全部不生效。
- **守恒不变量**：`conservedTotal()` = 全部剩余额度 + 根令牌净总消费 = 初始预算池。

金额为非负安全整数（最小货币单位）。

## 使用

```ts
import { BudgetLedger } from "./src/budget.js";

const ledger = new BudgetLedger();
ledger.createRoot("root", 1000);
ledger.allocate("root", "team-a", 400);
ledger.consume("team-a", 120, "order-1");
ledger.refund("order-1");          // 仅可一次
ledger.transferBatch([{ from: "team-a", to: "root", amount: 50 }]); // 原子
ledger.revoke("team-a");           // 未用额度返还 root
```

## 测试

```sh
npm test   # tsc 类型检查/编译 + node --test
```

测试内容：

- `test/budget.test.ts`：分配、消费汇总、退款一次性、撤销返还、批转原子性等单元测试。
- `test/fuzz.test.ts`：40 个随机种子 × 400 步随机操作（分配/消费/退款/撤销/批转），与独立参考模型逐字段比对，并校验每棵随机树历史满足守恒不变量。

## 实际测试结果（2026-10-05，Node v22.22.1）

```
> budget-ledger@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/budget.test.js
ok 1 - dist/test/budget.test.js
# Subtest: dist/test/fuzz.test.js
ok 2 - dist/test/fuzz.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms 389.726053
```
