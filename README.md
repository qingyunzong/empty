# factory-line-scheduler

离线单机工厂排产器。排产器与产线终端通过确认协议同步计划：命令 `PLAN` / `MOVE` / `CANCEL`
携带 `id`、`ver`、`cost`，终端回 `ACK` / `NAK`；丢包按指数退避重传，重复 ACK 去重，
乱序的低版本命令被忽略。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 使用

```sh
node cli.js ops.json --cap 100 --seed 7
node --test
```

参数：`--cap` 每日预算上限（必填）；`--seed` 丢包随机种子（默认 1）；
`--loss` 每个包（命令或 ACK）的丢失概率（默认 0.2）；`--base-delay` 退避基数 ms
（默认 100，第 n 次重传等待 `base * 2^(n-1)`）；`--max-attempts` 最大发送尝试次数（默认 8）。

## ops.json 格式

```json
[
  { "type": "PLAN",   "id": "job-a", "ver": 1, "start": 0, "cost": 40 },
  { "type": "MOVE",   "id": "job-a", "ver": 2, "start": 1, "cost": 50 },
  { "type": "CANCEL", "id": "job-a", "ver": 3 },
  { "type": "BEGIN" }, { "type": "COMMIT" }, { "type": "ROLLBACK" }
]
```

- `start` 为日索引（非负整数），`cost` 为正数；`MOVE` 的 `cost` 可省略（保持原值）。
- 可选 `loseSend: n` / `loseAck: n`：确定性地丢弃前 n 次发送 / 前 n 个 ACK（用于复现丢包，
  设置后该命令不再走随机丢包）。
- `BEGIN` / `COMMIT` / `ROLLBACK` 构成可嵌套事务；`ROLLBACK` 只能撤销当前未确认
  （未 ACK）的命令，已 ACK 的历史保留不动（记录在输出的 `keptAcked` 中）。

## 语义

- 每日预算 cap：`PLAN` 占用预算，`CANCEL` 释放，`MOVE` 原子地“释放旧占用再占用新”——
  任一步校验失败则整条命令不生效（旧占用保留），并记预算错误。
- 重复 `(id, ver)` 且内容一致 → 去重（ACK，不重复扣预算）；同 `(id, ver)` 内容冲突 →
  协议错误；`ver` 低于该 id 已确认版本 → 忽略（记入 `ignored`）。
- 预算不足：该命令状态不变，继续处理后续命令，进程退出码 5。
- 协议错误（格式非法、未知 id、id+ver 冲突、无 BEGIN 的 ROLLBACK 等）：立即中止，退出码 3。
- CLI 用法错误退出码 2；两者同时发生时 3 优先。

## 输出

stdout 为 JSON：`plan`（按 `(start, id)` 字典序）、`usage`（每日占用）、`ledger`
（预算流水，含 `seq/op/id/day/delta/used/cap`）、`pending`（未决重传队列，含尝试次数与
下次退避延迟）、`retransmissions`、`confirmed`、`ignored`、`rolledBack`、`keptAcked`、
`errors`、`exitCode`。

## 真实运行记录（2026-10-05, node v22.22.1）

`node cli.js examples/ops.json --cap 100 --seed 7` → 退出码 0：
`plan = [job-a(1,40,v2), job-c(1,50,v1), job-d(1,10,v1)]`，`usage = {"1": 100}`，
账本 7 条；`job-b` 的 `loseAck:1` 触发一次 ACK 重传（去重确认，预算只扣一次），
`job-a` 被随机丢包重传 2 次（退避 100→200ms）。

`node cli.js examples/ops-over-budget.json --cap 100 --seed 7` → 退出码 5：
`job-b`(cost 50, day0 已用 70) 预算不足被拒绝，状态不变（`usage = {"0": 70}`，
plan 仅含 `job-a`）。

`node cli.js examples/ops-protocol-error.json --cap 100 --seed 7` → 退出码 3：
`MOVE ghost v1: unknown-id`，中止前已确认的 `job-a` 保留。

`node --test` → 11 个子测试全部通过，覆盖四条验收标准：

1. 丢 ACK 重传不重复扣预算（账本仅 1 条扣费，退避序列 [100, 200]）；
2. `MOVE` 新位置超预算时旧占用保留（同日加价超 cap 同样拒绝）；
3. 嵌套未决事务按层级回滚（内层 `y`、外层 `x` 依次撤销，空栈 `ROLLBACK` 报协议错误）；
4. 40 个随机种子的小规模命令序列与账本逐条重放对照：每日占用始终 `0 ≤ used ≤ cap`，
   汇报 usage 与重放结果、计划成本按日求和完全一致。
