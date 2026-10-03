# offline-planner

离线单机生产计划库与 CLI。Node.js 22，仅使用标准库与 `node:test`。

## 运行

```bash
node --test                 # 运行全部测试
node cli.js job.json        # 从文件读取任务 JSON
cat job.json | node cli.js  # 从 stdin 读取
```

输出为计划 JSON（stdout）；失败时退出码为 1，错误 JSON 含 `error.code`。

## 输入模型

```jsonc
{
  "calendar": {
    "start": "2026-10-05T08:00:00Z",
    "horizonDays": 60,
    "shifts": [{ "days": [1,2,3,4,5], "start": "08:00", "end": "16:00" }],
    "restDays": ["2026-10-08"],
    "downtime": [{ "start": "...", "end": "..." }]
  },
  "machines": ["M1", "M2"],
  "orders": [{
    "id": "O1",
    "quantity": 2,
    "release": "...",
    "due": "...",
    "deadline": "...",
    "operations": [
      { "id": "a1", "machine": "M1", "cycleTime": 30, "alternatives": ["M2"] }
    ],
    "route": ["a1"]
  }],
  "commands": []
}
```

- `shifts`：周期班次，`days` 为星期（0=周日..6=周六，UTC），`start`/`end` 为 `HH:MM`。
- `restDays`：休息日例外（`YYYY-MM-DD`）。
- `downtime`：全局停线区间（绝对时间）。
- `quantity` 可选默认 1；工序时长 = `cycleTime * quantity`（分钟）。
- `due` 交期决定优先级；`deadline` 为硬截止（末工序 end 不得晚于它）。
- `route` 可选，默认按 `operations` 顺序；重复工序 id 视为循环路线。
- `commands` 缺省时等价于全部 `addOrder` 后 `schedule`。

命令脚本：`addOrder` / `addOrders` / `schedule` / `insertRush {order, budget}` /
`beginGroup {label}` / `commitGroup` / `undo` / `redo`。

## 排产语义

- 工序按路线先后放置在设备空闲区间（工作时间 − 停线 − 已占用）内，不可跨越休息或停线；
  订单在工序间允许等待，等待不计入加工时长。
- 订单优先级：交期升序、数量升序、ID 字典序。
- 每道工序取各候选设备上的最早可排开始时刻；多台设备并列同一最早时刻时，
  枚举全部并列方案，选择设备总空闲变化最小者（再并列按设备 ID）。
  设备空闲定义为该设备首个到最后一个占用区间之内的工时减去占用时长；
  填入既有空隙为负变化（优先），贴边扩展为 0，产生新空隙为正。
  并列决策记录在输出 `plan.decisions` 中。
- 急单重排：`insertRush` 全量重排并统计扰动订单数（任一工序的设备、开始或结束变化）。
  超过预算时调用参考算法（枚举全部可行开始时刻）求最小扰动数：
  若最小扰动仍超预算则失败且状态不变，返回可证明缺口
  `gap: { budget, required, deficit, proven }`；否则采用最小扰动方案。
- 撤销与恢复以命令组为单位：`beginGroup` 到 `commitGroup` 之间的命令构成一个撤销单元；
  组外命令各自成组。失败的重排不产生历史记录。

## 错误 CODE

- `VALIDATION`：输入非法（未知设备、非法时间、重复 ID 等）。
- `CYCLIC_ROUTE`：路线中工序重复（循环路线）。
- `CALENDAR_OVERLAP`：班次（同星期）或停线区间重叠。
- `INFEASIBLE`：视界内无可行放置或硬截止不可达。
- `BUDGET_EXCEEDED`：急单重排超扰动预算（附 `gap`），状态不变。
- `INVALID_STATE`：非法状态操作（如无历史可撤销）。

## 输出

- `plan.orders[].ops[]`：工序的 `machine`、`start`、`end`、`durationMinutes`。
- `plan.machines[]`：各设备占用区间与 `idleMinutes`。
- `plan.makespan`、`plan.totalIdleMinutes`、`plan.decisions`（并列枚举记录）。

## 参考算法

`src/reference.js` 的 `enumerateSchedules` 枚举所有半活跃可行调度
（每工序在每台候选设备上的全部可行开始时刻，并补充基线时刻以保证
零扰动方案可达），用于测试校验与最小扰动下界证明；`nodeCap` 限制
搜索规模，超限时 `proven: false`。
