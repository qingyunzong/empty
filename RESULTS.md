# RESULTS

日期：2026-10-02 ｜ 环境：Node.js v22.22.1，仅标准库，单机离线

## 测试（`node --test`，退出码 0）

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 4979.545737
  type: 'test'
  ...
# Subtest: test/pipeline.test.js
ok 2 - test/pipeline.test.js
  ---
  duration_ms: 1347.759443
  type: 'test'
  ...
# Subtest: test/scheduler.test.js
ok 3 - test/scheduler.test.js
  ---
  duration_ms: 2261.761526
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5133.288842
```

## CLI 实测（`node bin/plan.js run --in /tmp/demo/in --out /tmp/demo/out`，退出码 0）

输入：订单 A@T0；X@T0+2h10m（推进水位线）；B/C/D 事件时间乱序（迟到但可撤回）；
外加一条迟到 retract（不可撤回）。

- `schedule.json`：objective = `{"violations":0,"makespan":1790958600000,"energy":11}`，ties = 24（并列最优全部输出，按 job 字典序）
- `corrections.json`：3 条更正，trigger 依次为 B、C、D（验收 1）
- `late.log`：1 条 `LATE_NON_RETRACTABLE`（迟到的 retract A）

```
$ cat /tmp/demo/out/late.log
{"eventTs":1790949900000,"reason":"LATE_NON_RETRACTABLE","event":{"type":"retract","eventTs":1790949900000,"kind":"order","id":"A"}}
```

## 验收对照

1. 乱序订单引发三次更正 — `test/pipeline.test.js` “acceptance 1”，corrections 恰为 3 条 ✔
2. 保养撤回后恢复被挤掉的批量 — “acceptance 2”，violations 2 → 0 ✔
3. ≤8 作业全枚举对照并列最优 — `test/scheduler.test.js` “exhaustive cross-check”，n=1..8 与独立暴力枚举逐一比对目标值与并列序列集合 ✔
4. due 早于事件时间报 DUE_INVALID — `test/cli.test.js` “acceptance 4”，退出码 1 且 error.json code=DUE_INVALID ✔
