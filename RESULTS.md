# RESULTS

日期: 2026-10-02 13:32:26 UTC
运行时: v22.22.1

## `node --test`（仓库根目录，真实输出）

```text
TAP version 13
# Subtest: test/dag.test.js
ok 1 - test/dag.test.js
  ---
  duration_ms: 1622.022618
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
# duration_ms 1867.024042
exit code: 0
```

## 逐测试明细（`node test/dag.test.js`，真实输出）

```text
TAP version 13
# Subtest: random DAGs (<=20 nodes): invalidation set matches topological reference
ok 1 - random DAGs (<=20 nodes): invalidation set matches topological reference
  ---
  duration_ms: 497.930558
  type: 'test'
  ...
# Subtest: correcting a leaf never touches its siblings
ok 2 - correcting a leaf never touches its siblings
  ---
  duration_ms: 4.217413
  type: 'test'
  ...
# Subtest: fixed errors: CYCLE, MISSING_INPUT, BAD_CERT
ok 3 - fixed errors: CYCLE, MISSING_INPUT, BAD_CERT
  ---
  duration_ms: 10.232139
  type: 'test'
  ...
# Subtest: audit verifies hash chain from roots to leaves; tampering is caught
ok 4 - audit verifies hash chain from roots to leaves; tampering is caught
  ---
  duration_ms: 1.88374
  type: 'test'
  ...
# Subtest: gc keeps audit identical and only collects runner-confirmed tombstones
ok 5 - gc keeps audit identical and only collects runner-confirmed tombstones
  ---
  duration_ms: 8.505951
  type: 'test'
  ...
# Subtest: store survives a serialize/deserialize round trip
ok 6 - store survives a serialize/deserialize round trip
  ---
  duration_ms: 4.604339
  type: 'test'
  ...
# Subtest: CLI end-to-end: add/run/invalidate/audit/gc with JSON I/O
ok 7 - CLI end-to-end: add/run/invalidate/audit/gc with JSON I/O
  ---
  duration_ms: 48.991808
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 787.19957
exit code: 0
```
