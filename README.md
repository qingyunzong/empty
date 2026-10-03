# 工装寿命预约库及 CLI

Node.js 22，仅标准库，离线单机。测试使用 `node:test`：`npm test`（即 `node --test`）。

## 模型

- 时间：整数分钟，t0 = 0。
- 模具（mold）：`cycleMinutes`（保养周期/寿命上限）、`maintenanceMinutes`（保养时长）、
  `usedMinutes`（周期内已累计使用分钟）、`calendar`（可用工厂日历，若干 `[start, end)` 班次窗口，
  窗口外即休息）、`resetIntervals`（强制重置区间：区间内不可加工，时间线跨过后寿命归零）。
- 工单（order）：`durationMinutes` 加工时长。加工与保养都只能落在班次窗口内；
  同一模具上的事件顺序排列，保养天然不与其他保养重叠（不同模具的保养可以并列）。
- 寿命约束：若加工后累计使用会超过 `cycleMinutes`，先插入保养（寿命归零）再加工；
  若强制重置比保养更早到来，则等待重置（更少调整）。工单长于一个周期时会在中段多次保养。
- 调度是「模具配置 + 工单队列」的纯函数（`src/scheduler.js`），任何增删改后整体重算。

## 命令（JSON）

| cmd | 字段 | 说明 |
| --- | --- | --- |
| `addMold` | `id, cycleMinutes, maintenanceMinutes, usedMinutes?, calendar, resetIntervals?` | 登记模具 |
| `reserve` | `orderId, durationMinutes, moldId?` | 预约；不指定模具时自动选择 |
| `move` | `orderId, moldId?` | 移动到其他模具（追加队尾）；不指定时自动选择 |
| `cancel` | `orderId` | 取消并释放占用 |
| `correct` | `orderId, deltaMinutes` | 增量更正加工时长（可正可负） |
| `undo` | `txId` | 按工单事务撤销，恢复寿命与占用（撤销本身也是事务，可再撤销即重做） |
| `schedule` / `state` | — | 只读查询，不落盘 |

自动选择的比较键：**调整最少**（受影响模具的保养总次数）→ **最早完成** → **模具ID升序**。
每个写命令返回 `txId`，事务日志持久化在状态文件中。

## CLI

```sh
node src/cli.js --state state.json < commands.json   # stdin: JSON 命令数组，stdout: JSON 结果
```

每条命令是一个事务：应用后提交（commit）成功才生效；失败则回滚内存状态，
该命令标记 `ok:false`，后续命令基于最后一致状态继续。退出码：全部成功 0，任一失败 1。

故障注入（测试用）：环境变量 `TOOLING_FAULT_AT=beforeTempWrite|afterTempWrite|beforeRename`。

## 持久化与故障点（`src/store.js`）

提交协议，故障点明确：

1. `beforeTempWrite` —— 写临时文件之前（状态文件尚未被触碰）
2. 写 `<path>.tmp` 并 fsync
3. `afterTempWrite` —— 临时文件已落盘但未生效
4. `beforeRename` —— rename 之前（旧文件仍完整）
5. `rename(tmp, path)` —— **原子生效点：rename 完成才算提交成功**
6. `afterRename`

任一步失败：临时文件被清理，旧状态文件保持可打开、内容不变，无半笔事务；
`load` 只读正式路径，忽略残留的 `.tmp`。测试通过写入钩子在各故障点模拟崩溃。

## 文件

- `src/scheduler.js` —— 调度核心（纯函数）
- `src/system.js` —— 工单事务、自动选模、撤销
- `src/store.js` —— JSON 持久化（临时文件 + rename + 故障钩子）
- `src/cli.js` —— 命令行入口
- `test/` —— `node --test`：单元、持久化故障注入、CLI 端到端、三条验收场景，
  以及枚举保养位置的小规模暴力算法对照（`testlib/helpers.js` 的 `bruteForceSchedule`）
