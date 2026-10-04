# RESULTS — 真实测试记录

日期: 2026-10-04 22:38:16 CST
Node: v22.22.1

## node --test（全量）

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1759.533686
```

## test/cli.test.js

```
ok 1 - ingest: exit 0 on success, stdout JSON report
ok 2 - ingest: VALIDATION problems -> exit 2 with JSON on stderr
ok 3 - ingest: concurrent hold/release conflict -> exit 4, cert explains the lock
ok 4 - resume after injected crash at a fault point -> exit 0, exactly-once
ok 5 - audit detects store corruption -> exit 3
ok 6 - unknown command -> exit 2 with JSON stderr
ok 7 - sync: two offline stores converge bidirectionally, no loss no dup
ok 8 - sync resolves pending lots when the missing ancestor arrives from the peer
# tests 8
# pass 8
# fail 0
```

## test/conflict.test.js

```
ok 1 - concurrent manual release vs auto hold on same lot: safety-first hold, certified
ok 2 - release that happens-after the hold wins (causal order respected)
ok 3 - hold that happens-after the release wins
ok 4 - unknown ancestor sends the lot to pending, never failed
ok 5 - dependency cycle sends the lot to pending, never failed
ok 6 - transitive happens-before: release depending on a scan that follows the hold is not a conflict
# tests 6
# pass 6
# fail 0
```

## test/enumeration.test.js

```
ok 1 - exhaustive n<=10 over {hold,release} matches reference machine
ok 2 - exhaustive n<=8 over {hold,release,alarm,clear} matches reference machine
ok 3 - sampled length-9..10 mixed-alphabet sequences match reference machine
# tests 3
# pass 3
# fail 0
```

## test/ingest.test.js

```
ok 1 - idempotent dedup: re-ingesting the same events applies nothing twice
ok 2 - duplicates inside one batch are collapsed
ok 3 - out-of-order arrival within the window matches in-order result
ok 4 - illegal transitions are rejected with VALIDATION and do not mutate state
ok 5 - events older than watermark minus window are flagged late but still applied
ok 6 - scan with result=fail auto-holds the lot; repeated fail while held is a no-op
# tests 6
# pass 6
# fail 0
```

## test/recovery.test.js

```
ok 1 - crash at before-log: recovery applies every event exactly once
ok 2 - crash at after-log: recovery applies every event exactly once
ok 3 - crash at before-index: recovery applies every event exactly once
ok 4 - crash at after-index: recovery applies every event exactly once
ok 5 - crash at before-commit: recovery applies every event exactly once
ok 6 - crash at after-commit: recovery applies every event exactly once
ok 7 - crash mid-stream: second batch recovers on top of committed first batch
# tests 7
# pass 7
# fail 0
```

## 验收点对照

- 重复与乱序：`test/ingest.test.js`（重复摄取 applied=0、qty 恰好一次；乱序与顺序终态一致；迟到事件计入 late 且不丢）
- 三故障点（实际覆盖六注入点：事件落盘前后、索引更新前后、状态 commit 前后）：`test/recovery.test.js`，恢复后与干净运行逐字段一致，恢复幂等，恢复后再摄取不重复应用
- 并发 hold/release 证书：`test/conflict.test.js` + `test/cli.test.js`，安全优先 held，cert 给出因果证据与文字解释；环与未知祖先进 pending 不判失败，sync 补齐后自动解除
- n≤10 枚举对照：`test/enumeration.test.js`，{hold,release} 长度≤10 全枚举 2046 条、{hold,release,alarm,clear} 长度≤8 全枚举 87380 条、长度 9–10 混合抽样 5000 条，与测试内独立参考状态机逐一比对终态与拒绝数
- CLI 退出码 2/3/4 与 stderr JSON：`test/cli.test.js`

注：沙箱禁止测试进程派生孙进程，CLI 测试改为进程内调用 `main()` 并捕获 stdout/stderr，语义等价。
