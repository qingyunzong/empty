# 实际测试结果

日期: 2026-10-05 10:44:36 CST  Node: v22.22.1  tsc: Version 7.0.2

## `npm test`

```

> tpc-simulator@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/tpc.test.js
ok 1 - dist/test/tpc.test.js
  ---
  duration_ms: 466.437012
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 498.123984
```

## 单文件明细（node dist/test/tpc.test.js）

```
ok 1 - happy path: all YES votes commit everywhere
ok 2 - a single NO vote aborts everywhere
ok 3 - duplicate deliveries are idempotent on participants
ok 4 - coordinator crash after DECISION COMMIT: restart resumes from the log
ok 5 - coordinator crash mid phase 1: restart re-collects votes idempotently
ok 6 - undecided transaction is never masqueraded as a rollback
ok 7 - crash at every durable point still converges consistently
ok 8 - participant crash after PREPARED: restart replays its recorded vote
ok 9 - independent checker detects a fabricated rollback
ok 10 - independent checker detects divergent participant outcomes
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 92.151117
```
