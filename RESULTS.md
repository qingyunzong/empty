# RESULTS

日期：2026-10-03，环境：Node.js v22.22.1，仅标准库。

## 测试总览（`node --test`）

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7522.522639
```

## 各测试明细

```
$ node test/cli.test.js
ok 1 - due earlier than eventTs exits non-zero with DUE_INVALID
ok 2 - cli run writes schedule, corrections and late.log
ok 3 - malformed JSONL exits non-zero with PARSE_ERROR

$ node test/scheduler.test.js
ok 1 - simulate inserts changeover and joins maintenance windows
ok 2 - tied optima are all emitted, sorted by job lexicographic order
ok 3 - exhaustive <=8-job cases match brute-force tied optima

$ node test/stream.test.js
ok 1 - out-of-order orders produce three incremental corrections
ok 2 - maint retract restores the squeezed-out batch
ok 3 - late retract of known id corrects; unknown id goes to late.log

```
## 验收映射

- 验收1（乱序订单三次更正）：`test/stream.test.js` → "out-of-order orders produce three incremental corrections"；CLI 侧 `test/cli.test.js` 第 2 条断言 corrections.json 恰为 3 条。
- 验收2（保养撤回恢复批量）：`test/stream.test.js` → "maint retract restores the squeezed-out batch"，断言挤压期 J1 被推到保养窗后、撤回后回到原模具时段。
- 验收3（≤8 作业枚举对照并列最优）：`test/scheduler.test.js` → "exhaustive <=8-job cases match brute-force tied optima"，12 个随机例（1–8 作业、随机模具/批量/交期/保养窗）与独立暴力枚举逐一比对目标值与全部并列序列。
- 验收4（DUE_INVALID）：`test/cli.test.js` → "due earlier than eventTs exits non-zero with DUE_INVALID"，断言退出码非零且 error.json.code 为 DUE_INVALID。

## CLI 实跑示例

输入 `/tmp/plan-demo/in/events.jsonl`（7 条事件：3 准时订单 + 1 迟到保养 + 1 迟到订单 + 保养撤回 + 未知撤单）：

```
$ node bin/plan.js run --in /tmp/plan-demo/in --out /tmp/plan-demo/out
exit=0，输出 schedule.json / corrections.json / late.log
```

corrections.json（迟到保养与迟到订单各触发一次增量更正，保养撤回发生在水位线前、直接生效）：

```json
[
  {
    "seq": 1,
    "eventTs": 1700000300000,
    "kind": "maint",
    "id": "M1:1700002100000-1700002700000",
    "watermark": 1700000480000,
    "changedJobs": [
      "J1",
      "J2",
      "J3"
    ]
  },
  {
    "seq": 2,
    "eventTs": 1700000120000,
    "kind": "order",
    "id": "J4",
    "watermark": 1700000480000,
    "changedJobs": [
      "J4"
    ]
  }
]
```

late.log（未知 id 的迟到撤单不可撤回）：

```
eventTs=1700000180000 retract order GHOST: unknown id, beyond watermark 1700000880000, not retractable
```

错误路径实跑（due 早于 eventTs）：

```
$ node bin/plan.js run --in /tmp/plan-bad/in --out /tmp/plan-bad/out
exit=1
$ cat /tmp/plan-bad/out/error.json
{
  "code": "DUE_INVALID",
  "msg": "order J9: due (1699999999999) is earlier than eventTs (1700000000000)"
}
```
