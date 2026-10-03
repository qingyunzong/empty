# RESULTS

环境: v22.22.1, 仅标准库, node:test
日期: 2026-10-03 17:24:07 UTC

## `node --test`（完整测试套件，真实输出）

```
TAP version 13
# Subtest: test/snapshot.test.js
ok 1 - test/snapshot.test.js
  ---
  duration_ms: 3284.196681
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
# duration_ms 3576.523985
```

## `node test/snapshot.test.js`（逐项明细，真实输出）

```
TAP version 13
# Subtest: fault injection: three crash classes recover deterministically
ok 1 - fault injection: three crash classes recover deterministically
  ---
  duration_ms: 89.452636
  type: 'test'
  ...
# Subtest: diff: all pairs of versions match independent expectation
ok 2 - diff: all pairs of versions match independent expectation
  ---
  duration_ms: 9.04425
  type: 'test'
  ...
# Subtest: corrupt unreferenced chunk: materialize ok, verify ERR_CHUNK
ok 3 - corrupt unreferenced chunk: materialize ok, verify ERR_CHUNK
  ---
  duration_ms: 8.898628
  type: 'test'
  ...
# Subtest: empty and duplicate snapshots are idempotent
ok 4 - empty and duplicate snapshots are idempotent
  ---
  duration_ms: 1.894586
  type: 'test'
  ...
# Subtest: incremental materialize rewrites only changed files
ok 5 - incremental materialize rewrites only changed files
  ---
  duration_ms: 3.04569
  type: 'test'
  ...
# Subtest: ERR_DIRTY when writing over an uncommitted log
ok 6 - ERR_DIRTY when writing over an uncommitted log
  ---
  duration_ms: 3.193236
  type: 'test'
  ...
# Subtest: CLI: write fault, resume, verify, diff, materialize
ok 7 - CLI: write fault, resume, verify, diff, materialize
  ---
  duration_ms: 4.606305
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
# duration_ms 140.353737
```

## CLI 冒烟（真实输出）

```
$ node cli.js write /tmp/clidemo2/repo /tmp/clidemo2/src
{"version":"de59a4f44c4669bb","committed":true,"unchanged":false}
$ SNAP_FAULT=log-no-commit node cli.js write /tmp/clidemo2/repo /tmp/clidemo2/src
{"error":"ERR_CRASH","message":"simulated power loss: log written, index not committed"}  (exit=1, stderr)
$ node cli.js resume /tmp/clidemo2/repo
{"version":"de59a4f44c4669bb","rolledBack":true}
$ node cli.js verify /tmp/clidemo2/repo
{"ok":true,"version":"de59a4f44c4669bb","versions":["de59a4f44c4669bb"],"chunks":2}
```
