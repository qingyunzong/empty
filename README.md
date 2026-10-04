# settle-engine

贷款与订阅费按周期计划生成结算任务的库 + CLI。Node.js 22，仅标准库，单机离线。

## 模型

依赖图：合同 → 周期规则 → 日历版本 → 结算任务 → 扣款批次。
任何变更（改日历/补节假日、撤销/恢复合同）触发差分重算：只对受影响任务产生
added/removed/updated，失效传播到未执行批次；已执行批次与已扣款任务不可变，
撤销压力以冲正任务（`REV:<taskId>`，负金额）体现。

- 固定 UTC 时区；闰年规则：日级钳制到月末（2024-01-31 月付 → 2024-02-29；
  2024-02-29 年付 → 2025-02-28）。
- 同日多任务排序：`(dueDate, contractId, period, kind)`。
- `end < start` 报 `BAD_RANGE`，绝不静默产生空计划。
- 持久化：`events.jsonl` 为真相源（append+fsync），`queue.json` 为派生缓存。
  批次队列写入中途崩溃后重启，任务集合等于事件日志重放结果（撕裂缓存被检测并忽略）。

## 测试

```sh
node --test
```

## CLI

```sh
node cli.js --data <数据目录> [输入文件]   # 默认读 stdin
```

输入 JSONL，每行一个 op：`add_contract` / `revoke_contract` / `restore_contract` /
`add_holiday` / `set_calendar` / `create_batch` / `execute_batch`。
每行输出一个 JSON：`{ok, op, diff:{added,removed,updated,reversed}, batches, proof}`，
`proof.hash` 为规范化任务集合的 SHA-256，可用于重放等价性校验。
任何错误写 stderr 并以退出码 10 终止。

示例：

```sh
printf '%s\n' \
  '{"op":"add_contract","id":"L1","type":"loan","freq":"monthly","start":"2024-01-31","end":"2024-04-30","amount":1200}' \
  '{"op":"add_holiday","date":"2024-02-29"}' \
  '{"op":"create_batch","id":"B1","cutoff":"2024-03-05"}' \
  '{"op":"execute_batch","id":"B1"}' \
  '{"op":"revoke_contract","id":"L1"}' \
  | node cli.js --data /tmp/settle
```
