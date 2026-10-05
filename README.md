# tenant-slot-scheduler

离线运行的层级租户配额调度库 + CLI。Node.js 22，仅标准库，测试使用 `node:test`。

多条产线的生产时隙按租户树分配：每个租户有保障配额，空闲配额可出借；
保障租户收回配额时按"最晚借用、最低优先级"抢占借用人，并沿租户树逐级回滚已记账用量；
等待超过饥饿阈值的本租户工单优先于借用。

## 运行

```bash
node src/cli.js examples/reclaim.json        # 从文件读取
cat examples/borrow.json | node src/cli.js   # 从 stdin 读取
node src/cli.js input.json --compact         # 紧凑输出
npm test                                     # node --test
```

## 输入格式

```json
{
  "config": { "starveAfter": 2, "horizon": 10, "trace": true },
  "tenants": [{ "id": "R", "parent": null, "guarantee": 2 }],
  "orders": [{ "id": "o1", "tenant": "A", "duration": 3, "priority": 1, "arrive": 0 }],
  "commands": [
    { "tick": 2, "type": "submit", "order": { "id": "o2", "tenant": "A", "duration": 1 } },
    { "tick": 3, "type": "reclaim", "tenant": "A", "amount": 2 }
  ]
}
```

- `starveAfter`：饥饿阈值（tick 数），缺省为无穷（不触发自动收回）。
- `horizon`：模拟截止 tick（也可放顶层）；缺省运行到所有工单结束。
- `trace`：为每个 tick 附带全树用量快照。
- `reclaim` 的 `amount` 缺省表示收回该租户全部借出配额。

## 模型与不变式

- 每个节点 `guarantee` 为每 tick 时隙数；根节点保障配额即系统总上限。
- 校验规则（失败即报错退出）：
  - `TENANT_CYCLE` 租户树存在环路；`NO_ROOT` / `MULTIPLE_ROOTS` 根节点不唯一；
  - `NEGATIVE_QUOTA` 负配额；`INVALID_QUOTA` 非整数配额；
  - `QUOTA_EXCEEDS_PARENT` 子节点配额超过父节点（传递地保证不超过根上限）；
  - `CHILDREN_EXCEED_PARENT` 子节点配额之和超过父节点。
- 每个节点维护逐级记账：`usage`（子树运行数）、`lentOut`（借给子树外）、
  `borrowedIn`（从子树外借入）、`ownLent`（本租户借出的活跃记录数）。
- 全程保持不变式（每 tick 校验，违反即内部错误）：
  `usage(n) <= guarantee(n) - lentOut(n) + borrowedIn(n)`，任何节点不得超额。
- 借用 `A -> B` 可行的充要条件：`A` 到根路径上每级 slack 都 >= 借用量
  （根在路径上，因此自动满足根上限）。借用/归还沿 LCA 两侧路径更新记账。

## 每 tick 调度顺序

1. 处理该 tick 的命令（`submit` / `reclaim`）。
2. 饥饿下限：等待 `>= starveAfter` 的本租户工单优先于借用——
   若本租户配额被借出占住，自动按抢占规则收回（reason=`starvation`）。
3. 阶段 A：各租户先用自有保障配额（有饥饿工单的租户优先，其余按 id 字典序）。
4. 阶段 B：借用空闲配额。借用人按 id 字典序、出借人按 id 字典序贪心，
   达到最大配额利用率；平局按字典序（靠前的借用人优先分满、优先用靠前的出借人）。
5. 运行中的工单推进 1 个时隙，完成的释放配额并逐级回滚记账。

## 收回与抢占

- 抢占顺序：最晚借用者优先，并列时最低优先级者优先，再按工单 id 字典序。
- 释放量精确：`reclaim` 指定 `amount=k` 时恰好抢占 `min(k, 活跃借出数)` 个时隙。
- 被抢占工单回滚：进度清零、回到等待队列，记账沿借用人到根逐级回滚，
  出借/借入路径同步回滚；回滚后任何节点不得超额（由不变式保证并断言）。
- 收回配额的租户在该 tick 内不再出借（防止刚收回又被借走）。

## 输出

```json
{
  "ok": true,
  "root": "R",
  "nodes": [{ "id", "parent", "guarantee", "usage", "lentOut", "borrowedIn", "ownLent", "slack" }],
  "borrowChain": [{ "id", "tick", "lender", "borrower", "orderId", "priority", "status" }],
  "preemptions": [{ "tick", "orderId", "lender", "borrower", "reason", "released" }],
  "schedule": [{ "tick", "started", "completed", "preempted", "nodes?" }],
  "orders": [{ "id", "tenant", "status", "startTick", "finishTick", "funding", "preempts" }],
  "summary": { "ticks", "totalOrders", "completed", "borrowedSlots", "preemptedSlots" }
}
```

校验失败时输出 `{"ok": false, "error": {"code", "message"}}` 并以退出码 1 结束。

## 库用法

```js
import { simulate } from './src/scheduler.js';
const report = simulate(input); // 抛出带 .code 的 ValidationError 表示输入非法
```

## 测试

`npm test`（即 `node --test`）。覆盖：

- `test/borrow.test.js` 空闲配额成功借用、自有配额优先、根上限约束；
- `test/reclaim.test.js` 收回引发多级回滚且释放量精确、部分收回、最晚借用先被抢占；
- `test/starvation.test.js` 超过饥饿阈值的本租户工单抢占借用人；
- `test/validation.test.js` 环路租户、负配额、超过根上限等校验失败；
- `test/enumeration.test.js` 小规模枚举所有借用组合，验证最大配额利用率与字典序平局；
- `test/cli.test.js` CLI 文件/stdin 输入、结构化错误与退出码。
