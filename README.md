# event-trace

边缘网关离线事件追溯库 + CLI：采集 PLC 报警与质检扫码事件，离线缓存后与追溯库双向同步。
目标：**不丢、不重，并且每个批次为什么被锁定都能解释**。

仅依赖 Node.js 22 标准库与 `node:test`，单机离线运行。

## 事件模型

JSONL 输入，每行一个事件：

```json
{"id":"e1","ts":1700000000000,"device":"plc-1","lot":"L1","kind":"quality.hold","payload":{"reason":"suspect"},"parents":["e0"]}
```

- 必填：`id`、`ts`、`device`、`lot`、`kind`、`payload`（可缺省为 `{}`）；可选 `parents`（因果祖先，用于 happens-before 判定）。
- `kind` ∈ `quality.hold` / `quality.release` / `quality.check`（`payload.result` 为 `pass|fail`，`fail` 触发自动超差 hold）/ `device.alarm` / `device.clear`。
- `quality.hold` 带 `payload.auto=true` 视为自动 hold（幂等记录）；人工 hold/release 是严格命令。

## 状态机

- 质量维：`ok → hold → released`。非法迁移（无 hold 的 release、重复 hold、重复 alarm、无 alarm 的 clear 等）报 `VALIDATION`（退出码 2），事件被拒并记入审计，不丢但不算已应用。
- 设备维：每 `(lot, device)` `clear ↔ alarming`。
- 批次锁定 = 质量 hold 或任一设备 alarming；`cert` 输出人可读的锁定原因。

## 冲突与 happens-before

人工放行与自动超差同批并发时按因果图（`parents`）判定：

- 可判定先后：按因果顺序应用；自动超差**因果晚于**放行 → `VALIDATION`。
- 并发（互相不可达）：**安全优先，hold 胜出**。放行被覆盖（`overridden`），批次锁定，证书记录覆盖链。
- 环或未知祖先：进 **pending**，**绝不判失败**；祖先经后续 ingest/sync 到达后自动重试解决。

## 持久化与恰好一次

数据目录：`inbox.log`（先落盘的接收缓冲）、`events.log`（追加+fsync）、`index.json` / `lots.json` / `pending.json`（tmp+rename 原子写）、`journal.log`（事务阶段）、`audit.log`（决策记录，可重放重建）。

每个事件的事务阶段：**事件落盘 → 索引更新 → 状态 commit**，六个故障注入点（`before/after-log`、`before/after-index`、`before/after-commit`）。恢复时以 `lots.json` 为已提交真值，对账 `events.log`/`index.json`，幂等重放未完成的收件箱与日志事件，`audit.log` 由确定性重放整体重建——恢复后每个事件恰好应用一次。

故障注入（测试用）：`EVENT_TRACE_FAULT=<point> EVENT_TRACE_FAULT_TX=<id>`，进程以 99 退出模拟崩溃。

## CLI

```
event-trace ingest --dir D [--file F | stdin] [--window-ms N]
event-trace sync   --dir D --remote R
event-trace resume --dir D
event-trace audit  --dir D [--lot L]
event-trace cert   --dir D --lot L
```

- stdout：JSON 报告 / 证书 / 审计 JSONL；stderr：JSON 错误 `{"code", "error", "message", ...}`。
- 退出码：`0` 成功（pending 不算失败）；`2` VALIDATION（非法迁移/畸形事件）；`3` USAGE/NOT_FOUND（缺参数、未知批次、远端不存在）；`4` INTERNAL（IO/状态文件损坏）；`99` 注入故障。
- `--window-ms`：乱序窗口（默认 300000）。水位线 = 已应用最大 ts；`ts < watermark - window` 的事件标记 `late` 但仍应用（不丢）。

## 测试（真实结果）

`node --test`，Node v22.22.1，2026-10-04 实跑：**5 个测试文件、26 个子测试全部通过，0 失败**。

- `test/engine.test.js`（5）：乱序重排、幂等去重、late 标记、非法迁移 VALIDATION、畸形事件。
- `test/reference.test.js`（3）：与**独立参考状态机**（`test/helpers/reference.js`，独立实现）对照——5 字母表全枚举 n≤6 共 **19531** 条序列、带因果/幽灵祖先/环/洗牌的随机序列 n∈7..10 共 500 条、重复投递 100 条，终态逐一 deepEqual。
- `test/faults.test.js`（2）：六个故障点逐一注入崩溃（exit 99）→ `resume` → `events.log`/`lots.json`/`index.json`/`audit.log` 与无故障运行逐字节一致，且重复 ingest 全量去重；首事件落盘前崩溃由收件箱重放不丢。
- `test/conflict.test.js`（7）：并发放行/超差两种顺序均锁定且证书解释一致；因果在后的超差报 VALIDATION；未知祖先/环进 pending 不判失败；双向 sync 后两端收敛为锁定且 `overridden` 一致；pending 经 sync 补祖先后解决。
- `test/cli.test.js`（9）：退出码 2/3/4 与 stderr JSON、stdin 管道、audit 过滤、健康目录 resume 幂等。

最近一次运行摘要：

```
✔ test/cli.test.js       ✔ test/conflict.test.js   ✔ test/engine.test.js
✔ test/faults.test.js    ✔ test/reference.test.js
# tests 5  # pass 5  # fail 0
```
