# settlement-scheduler

贷款与订阅费按周期计划生成结算任务的库与 CLI。Node.js 22，仅标准库，单机离线。

## 模型与依赖图

```
合同(contract) → 周期规则(rule) → 日历版本(calendar) → 结算任务(task) → 扣款批次(batch)
```

- 每次变更只重算受影响子图，输出未来（未扣款）任务的增删差分 `{added, removed, reversals}`，
  开放批次组成变化时级联失效 `{batches: {added, invalidated}}`。
- 已扣款任务不可改：撤销合同只生成冲正任务（`key#R`，负金额，落在原结算日的新开放批次）。
- 同日多任务按 `(contractId, period, kind)` 排序决胜（批次内任务数组即此顺序）。
- `end < start` 报 `BAD_RANGE`，绝不静默生成空计划。
- 确定性：UTC 日精度、月末钳制（2024-01-31 +1mo → 2024-02-29）、锚定月算术无漂移、
  状态证明 `proof.stateHash` 为规范化状态的 SHA-256。

## 持久化与故障点

- `events.jsonl`：追加式操作日志（每次 fsync），重放即状态真源。
- `batches.json`：批次队列快照，`tmp → fsync → rename` 原子写，信封含 SHA-256 校验和。
- 故障点为写批次队列中途：重启时校验和/一致性检查失败即丢弃快照，从事件日志重放重建，
  任务集合恒等于重放结果（见 `test/persist.test.js`）。

## 测试

```sh
node --test
```

覆盖：闰年边界、周末顺延、撤销后恢复（幂等无重复）、日历切换级联与回切、
小规模枚举对照、已扣款不可改+冲正、BAD_RANGE、同日排序决胜、规则增删动态拓扑、
证明哈希确定性、崩溃中写重放一致、CLI 差分/证明/退出码 10。

## CLI

JSONL：stdin 每行一个命令，stdout 每行一个结果（含差分与证明）；
错误写 stderr 并以退出码 10 终止。

```sh
printf '%s\n' \
  '{"op":"add_rule","rule":{"id":"m1","freq":"monthly","interval":1}}' \
  '{"op":"add_contract","contract":{"id":"L1","type":"loan","start":"2024-01-31","end":"2024-04-30","ruleId":"m1","amount":100}}' \
  '{"op":"set_calendar","calendar":{"version":"v2","holidays":["2024-02-29"]}}' \
  '{"op":"debit_batch","date":"2024-01-31"}' \
  '{"op":"revoke_contract","id":"L1"}' \
  '{"op":"restore_contract","id":"L1"}' \
  '{"op":"dump"}' \
| node src/cli.js --state ./.state
```

操作：`add_rule`（同 id 覆盖并重算引用合同）、`remove_rule`（被活跃合同引用报 `RULE_IN_USE`）、
`add_contract`、`revoke_contract`、`restore_contract`、`set_calendar`、`debit_batch`、`dump`。
