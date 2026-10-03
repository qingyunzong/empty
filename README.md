# tenant-slot-scheduler

多租户生产时隙分配库与 CLI。Node.js 22，仅使用标准库与 `node:test`，完全离线运行。

## 模型与规则

- **租户树**：根节点持总上限 `capacity`，非根租户持保障配额 `guarantee`（须为非负整数）。
  校验规则：唯一根、父引用必须存在、无环（`CYCLE`）、负配额失败（`NEGATIVE_QUOTA`）、
  任一节点的子节点保障配额之和不得超过该节点配额（根为 `ROOT_CAP_EXCEEDED`，其余为
  `PARENT_CAP_EXCEEDED`）。
- **记账**：工单被调度后，其单位沿租户到根的路径逐级计入 `used`。任何节点满足
  `used ≤ limit`，其中 `limit = guarantee - lentOut + borrowedIn`（根为 `capacity`）。
- **借用**：工单超过本租户有效配额时，可向有空闲配额的租户借用（不可向自身及祖先借用；
  借来的配额不可再转借，避免级联超额）。每次借用记录为借用链（`borrowChain`）中的一条
  `{time, lender, borrower, order, amount}`。
- **收回与抢占**：`reclaim` 命令中，收回量 = `min(已借出, 本租户等待需求缺口)`。
  按"最晚借用、最低优先级"（借用时刻降序、工单优先级升序、工单 id 升序）选择借用人，
  部分回滚其工单活跃量并沿租户树逐级减账，释放量精确等于收回量；回滚后任何节点不超额。
  收回后先为收回方补排其等待工单，再做全局排程。
- **饥饿下限**：等待时间 ≥ `starveThreshold` 的工单，其所属租户的空闲配额会被保留
  （`reserved`），不再出借给其他租户——本租户工单优先于借用。
- **调度目标**（每个时刻命令后执行一次排程）：
  1. 最大化总调度单位（配额利用率）；
  2. 平局时取已排工单 id 字典序最小者；
  3. 再平局时取借用方案字典序最小者（按 `[lender, order, amount]` 排序比较）。
  候选工单 ≤ 10 且出借方 ≤ 5 时精确枚举所有工单子集 × 出借方排列；否则退化为贪心。
  工单调度是原子的（全部单位排入或继续等待），抢占允许部分回滚。

## 输入格式（scenario JSON）

```json
{
  "starveThreshold": 3,
  "tenants": [
    { "id": "root", "parent": null, "capacity": 100 },
    { "id": "alpha", "parent": "root", "guarantee": 30 }
  ],
  "orders": [
    { "id": "b1", "tenant": "beta", "units": 25, "priority": 1, "submit": 0 }
  ],
  "commands": [
    { "cmd": "tick", "time": 0 },
    { "cmd": "reclaim", "tenant": "alpha", "time": 2 }
  ]
}
```

- `orders[].priority` 越大优先级越高（影响抢占顺序），`submit` 为提交时刻。
- `commands` 按 `time` 稳定排序执行；`tick` 推进时刻并排程，`reclaim` 触发收回后补排程。

## 输出字段

- `nodes`：每节点配额（`guarantee`/`capacity`）、`used`、`lentOut`、`borrowedIn`、有效 `limit`、`headroom`。
- `borrowChain`：全部借用事件（借用链）；`borrows`：仍未归还的借用。
- `preemptions`：抢占记录；`reclaims`：收回记录（含精确 `released`）。
- `schedule`：最终排程（`scheduled` / `partial` / `waiting`）。
- `utilization`：根节点利用率。

## 使用

```bash
node src/cli.js examples/borrow.json          # 运行场景，输出 JSON 报告
node src/cli.js --pretty examples/reclaim.json
node src/cli.js --check examples/borrow.json  # 仅校验
cat scenario.json | node src/cli.js -         # 从标准输入读取
```

库接口见 `index.js`：`buildTree`、`Scheduler`、`runScenario`、`prepare`、`validateScenario`。

## 测试

```bash
node --test        # 或 npm test
```

测试覆盖：空闲配额借用、收回引发的多级回滚与精确释放、环路/负配额/超根上限校验失败、
饥饿保留、以及小规模枚举所有借用组合验证最大配额利用率与字典序平局
（`test/enumeration.test.js` 内含独立的暴力枚举参照实现）。
