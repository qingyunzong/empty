# offline-scheduler

Node.js 22，仅标准库。离线排程库 + 单机 CLI：为工单选择机台方案，消耗
(material, day) 维度的物料预算（钢卷、工时等可替代物料），基于 MVCC +
快照隔离 + 预算二级索引，提交时重算预算谓词，确定性选择方案并出具证书。

## 概念

- **方案 (plan)**：若干 `(machine, day, material, amount)` 分配的集合。
- **预算 (budget)**：`(material, day) -> limit`，已提交分配总和不得超过。
- **确定性选择**：事务在快照上评估候选方案，取可行者中规范化 JSON
  （键排序、分配排序）字典序最小者；证书列出全部被比较方案的 SHA-256 哈希。
- **提交时重验证**：提交前对订单触及的每个 `(material, day)`，通过二级索引
  重算全部已提交分配总和，超预算则整体回滚并抛 `E_BUDGET`。谓词作用于共享
  索引而非订单键，因此两个写不同工单的事务无法绕过同一预算。

## API

```js
const { Scheduler } = require('./src/scheduler');
const s = new Scheduler();
s.setBudget('steel', 1, 100);
s.addOrder('W1', [planA, planB]);
s.scheduleOrder('W1');                  // -> { commitSeq, certificate }
const t1 = s.begin(), t2 = s.begin();   // 并发事务（快照隔离）
t1.stageOrder('W1'); t2.stageOrder('W2');
t1.commit(); t2.commit();               // 超预算者抛 E_BUDGET 并回滚
```

`src/enumerate.js` 提供 `enumerateFeasibleAssignments(orders, budgets)`
（≤3 工单的 DFS 穷举 + 剪枝）与 `selectOptimalAssignment`（字典序最优）。

## CLI

```sh
node cli.js --db db.json budget set <material> <day> <limit>
node cli.js --db db.json order add <id> '<plansJson>'
node cli.js --db db.json plan <orderId>        # 干跑，不提交
node cli.js --db db.json commit <orderId>      # 提交并输出证书
node cli.js --db db.json enumerate <id,id,...> # ≤3 工单穷举
node cli.js --db db.json allocations | state
```

输出为 JSON。退出码：`0` 成功；`1` 领域错误（`E_BUDGET`、
`E_ORDER_NOT_FOUND`、`E_ORDER_STATE` 等，JSON 中含 `error.code`）；`2` 用法错误。

## 测试

```sh
node --test
```
