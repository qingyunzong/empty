# hts-plate-scheduler

384 孔板重跑调度器（高通量筛选实验室）。Node.js 22，仅用标准库与 `node:test`。

## 运行

```sh
node bin/labsched.js [--journal PATH] [--config JSON] [input.jsonl]   # 无输入文件时读 stdin
node --test test/*.test.js
```

输出 JSON：通道时间线（`channels[].blocks`，含 `run`/`cooldown` 块）、事件流、
最终排队顺序（`waiting`）、项目预算、污染孔数、失败码（`failures`）与确定性日志根
（`logRoot`，SHA-256 哈希链）。数据错误 `VOLUME_EXCEEDS_PLATE` / `BUDGET_NEGATIVE` /
`COOLDOWN_CONFLICT` 以退出码 5 终止。

## JSONL 操作

```jsonl
{"op":"enqueue","id":"e1","time":0,"task":{"id":"t1","project":"P1","volume":30,"priority":1,"segments":[{"temp":20,"duration":10},{"temp":37,"duration":5}]}}
{"op":"budget","id":"b1","project":"P1","set":100}
{"op":"correct","id":"c1","taskId":"t1","volume":40}
{"op":"abort","id":"a1","taskId":"t1"}
{"op":"undo","id":"u1"}
```

- `time` 可选（默认当前时间）；`id` 可选，用于崩溃恢复后的幂等去重。
- `budget` 为绝对设定；未设定的项目预算无限。设定为负 → `BUDGET_NEGATIVE`（exit 5）。
- `correct` 修改体积并触发可行性重算：孔容量、已扣费用的差额调整（差额致负 → exit 5）。
- `undo` 按操作栈层级回滚（弹出最近一条非 undo 操作并重放）；已确认污染孔不复活。

## 语义

- **预算**：任务首次上机时按 `volume × costPerUnit` 扣费；欠费（预算 < 费用）禁止新任务
  启动，但不强制终止已在关键段（执行中段）的任务。
- **抢占**：仅允许在温控段边界发生；高优任务等待时标记最低优在跑任务，其当前段完成后
  暂停（保存已完成段进度），之后可从断点恢复，不重复扣费。
- **公平**：优先级降序 → 等待老化（先到先服务）→ 项目间轮转 → 任务 ID 升序。
- **温控**：通道切温固定冷却 `cooldown` 时间单位；同任务相邻段温差超过
  `maxTempDelta` → `COOLDOWN_CONFLICT`（exit 5）。
- **容量**：体积换算孔数 `ceil(volume / wellVolume)`，单板或单任务超 `plateWells`
  → `VOLUME_EXCEEDS_PLATE`（exit 5）。运行中 abort 的任务在段边界停止，其孔确认污染，
  永久计入 `contaminatedWells`，undo 不复活。
- **日志**：`--journal` 追加 `{seq, prev, hash, op}` 哈希链行；启动时恢复——校验链、
  截断撕裂尾部、重放操作，已应用的 `id` 跳过，保证不重复扣费。

## 配置（默认值）

`channels=2, plateWells=384, wellVolume=10, cooldown=5, maxTempDelta=40,
initialTemp=25, costPerUnit=1`，可用 `--config '{"channels":4}'` 覆盖。

## 结构

- `src/scheduler.js` — 确定性事件驱动调度器（通道、冷却、抢占、公平排序）
- `src/engine.js` — 操作处理、undo 重放、污染持久化、日志链
- `src/journal.js` — 追加式哈希链日志与撕裂恢复
- `src/enumerate.js` — n≤8 最小完成时间枚举 oracle（子集 DP + 通道划分），供验收对照
- `bin/labsched.js` — CLI
