# RESULT — 真实测试结果

环境：Node.js v22.22.1，仅标准库，`node --test`，单机离线。
运行时间（UTC）：2026-10-03T07:38:38Z

## 总览（`node --test`）

```
# tests 4
# pass 4
# fail 0
# duration_ms 15418.810128
```

4 个测试文件、19 个子测试全部通过。

## 逐文件结果（各文件直接运行的 TAP 子测试）

### test/dates.test.js
```
ok 1 - leap year rules (incl. century boundaries)
ok 2 - parseDate accepts only real calendar dates
ok 3 - epoch-day conversion round-trips
ok 4 - addMonths clamps day to target month length
```

### test/engine.test.js（验收 A / B / C + 审计）
```
ok 1 - A: type interval inherited; individual cert overrides; earlier of revoke/expiry wins
ok 2 - A: without revocation, measurements stay qualified and expiry invalidates
ok 3 - B: restore re-opens usability but history stays pending_retest
ok 4 - B: restore requires same institution and strictly higher level
ok 5 - C: leap-year boundary for issue, expiry and measurement dates
ok 6 - audit: usable set is recomputed from any as-of date
```

### test/counterexample.test.js（验收 D）
```
ok 1 - counterexample: minimal revocation set is exact
ok 2 - counterexample: returns null when work order is already not ok
ok 3 - D: enumeration cross-check over <=30 days / 6 instruments
```
D 项日志：`cross-checked 365 ok work orders against brute force`
（300 个随机场景、6 器具、30 天窗口；直接解与全子集枚举的大小逐一相等，
且直接解给出的撤销集应用后工单确实变为非 ok。）

### test/cli.test.js（端到端 + 退出码）
```
ok 1 - run writes status.json and impact.jsonl with correct semantics
ok 2 - counterexample prints the minimal revocation set
ok 3 - exit 25 on invalid dates
ok 4 - exit 26 on untrusted institution
ok 5 - exit 27 on restore chain self-reference (direct and cyclic)
ok 6 - exit 1 (not 25/26/27) for restore policy violations
```

## 端到端示例（examples/，`--as-of 2024-08-01`）

`node src/cli.js run --dir examples --as-of 2024-08-01` 实际输出要点：

- `status.json`：`usable_instruments = [TW-001, TW-002, GB-001]`；
  TW-002 证书 2024-02-29 签发、12 个月，有效期至 2025-02-28（闰年钳制）；
  工单 WO-1001=`retest_required`、WO-1002=`illegal`、WO-1003=`ok`。
- `impact.jsonl`：M2（GB-001，2024-03-05，证书后被撤销）=`pending_retest`；
  M3（撤销—恢复空窗期）=`invalid`；M5（恢复后区间）=`qualified`。
- 审计回溯：同一输入 `--as-of 2024-05-01`（撤销发生前）重算，
  GB-001 可用、WO-1001=`ok` —— 撤销立即反映到在制工单。
- 反例：`counterexample --work-order WO-1003` 输出
  `minimal_revocations = ["C-TW2-A"]`，`size = 1`。

## 环境备注

本沙箱中 node 子进程的管道 stdout 会被吞掉（`/bin/echo` 正常），
因此 `test/cli.test.js` 通过将子进程 stdout/stderr 重定向到临时文件再读回来断言；
CLI 本身在真实终端下直接输出正常。
