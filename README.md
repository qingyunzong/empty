# recon-rollback

渠道对账差异的三级（day / mch / txn）回滚重算工具。仅依赖 Node.js 22 标准库，测试使用 node:test。

## 输入

- `confirmed.jsonl`：已确认快照，每行 `{target, amount, level?, version?, parent?, locked?}`。
  `target` 按 `/` 分层：`2024-01-01`（day）、`2024-01-01/M001`（mch）、`2024-01-01/M001/T001`（txn）。
- `deltas.jsonl`：修正事件，每行 `{scope, target, amount, eventTime, seq}`，`scope ∈ day|mch|txn`。

## 机制

- delta 作用于目标最近一个未 `locked` 的版本，生成新版本（`status: "corrected"`）；locked 快照只读，delta 进入 `pending`。
- 同一 target 的并发 delta 按 `(eventTime, seq)` 排序；键完全相等的并列项全部输出并标记 `TIE`，不随机取舍。
- `--watermark <iso>`：事件时间晚于水位线的 delta 进入 `pending`，不参与本次重算。
- `--rollback day|mch|txn:target[@version]`：回滚生成 `rolled_back` 新版本（审计轨迹保留，旧版本不删除）。
  回滚 day 隐含撤销其下 mch/txn 修正；回滚 txn 不影响兄弟交易。目标或版本不存在时输出 `NO_VERSION`。
- 输入快照的 parent 链成环时，CLI 以退出码 6 终止。

## 输出

`versions.jsonl`，每行 `{level, target, version, parent, amount, status}`，
`status ∈ confirmed|corrected|TIE|rolled_back|pending|NO_VERSION`。

## 使用

```sh
node cli.js recon --base c.jsonl --deltas d.jsonl --rollback day:2024-01-01
# 可选：--rollback mch:2024-01-01/M001@2 --watermark 2024-01-03T00:00:00Z --out -
```

## 测试

```sh
node --test
```
