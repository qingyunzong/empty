# htsp-scheduler

高通量筛选实验室 384 孔板重跑调度器。Node.js 22，仅标准库，测试用 `node:test`。

## 运行

```bash
node bin/labsched.js --input ops.jsonl [--config cfg.json] [--log run.log] [--out result.json] [--resume]
node --test test/*.test.js
```

输出（stdout 或 `--out`）：通道时间线 `channels[].events`（`run`/`cooldown`/`idle`）、
任务状态 `tasks`、剩余排队快照 `queue`、失败码 `failures`、确定性日志根 `logRoot`。

## 操作（JSONL，每行一个）

```json
{"op":"budget","project":"P1","set":100}
{"op":"enqueue","at":0,"task":{"id":"T1","project":"P1","volume":30,"priority":5,"segments":[{"temp":37,"duration":10}]}}
{"op":"correct","taskId":"T1","volume":40}
{"op":"abort","taskId":"T1"}
{"op":"undo"}
```

- `at` 为可选逻辑到达时间（默认 0），同时刻按文件顺序应用。
- 费用 = `volume × costPerUnit`，enqueue 时扣减并写 `charge` 日志；欠费（预算不足）
  拒绝新任务，但不强制终止已在运行的温控段。
- `correct` 改体积并重算可行性（孔位、预算差额补扣/退回）。
- `abort` 把任务占用孔标记为确认污染（污染孔永久扣减可用容量）。
- `undo` 按操作栈 LIFO 回滚；回滚 abort 返回 `E_CONTAMINATED_REVIVE`（禁止复活污染孔）。

## 调度语义

- 仪器有 `channels` 个并行通道；段间/任务间换温冷却 = `cooldownPerDegree × |ΔT|`，占用通道。
- 抢占只发生在温控段边界：等待任务有效优先级（优先级 + 等待老化 `agingInterval`）
  严格高于运行任务时，运行任务在段边界让出通道，已完成段数保存，之后从中断段恢复。
- 公平：项目间轮转（`lastServedSeq`），项目内按有效优先级，同分按任务 ID。
- 同项目、同优先级、数量 ≤ `exactThreshold`(8) 的就绪批次使用精确枚举
  （子集 DP + 分配枚举）优化最小完成时间。

## 退出码

- `0` 全部成功；`2` 用法/输入错误；
- `5` 体积超板 `E_VOLUME_EXCEEDS_PLATE`、预算负 `E_BUDGET_NEGATIVE` /
  欠费 `E_INSUFFICIENT_BUDGET`、冷却冲突 `E_COOLDOWN_CONFLICT`；
- `1` 其它操作失败。

## 日志与崩溃恢复

`--log` 追加写 JSONL 哈希链（`sha256(prev|seq|type|canonical(data))`），`logRoot`
为链根。`--resume` 校验链前缀、截断撕裂行后重放 op 事件重建状态；扣费由日志
派生，崩溃恢复不会重复扣费。

## 配置（均有默认值，见 `src/config.js`）

`channels, plateWells(384), wellCapacity, ambientTemp, cooldownPerDegree,
costPerUnit, agingInterval, maxTempJump, exactThreshold`
