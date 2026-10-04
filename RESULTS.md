# 实际测试结果

- 日期: 2026-10-05 07:09:08 CST
- Node.js: v22.22.1
- tsc: Version 7.0.2
- 命令: `npm test`（tsc 编译后运行 node --test）

```

> signal-window@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/rational.test.js
ok 1 - dist/test/rational.test.js
  ---
  duration_ms: 181.150227
  type: 'test'
  ...
# Subtest: dist/test/signal.test.js
ok 2 - dist/test/signal.test.js
  ---
  duration_ms: 236.451165
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 258.991851
```

各测试用例明细：

```
# Subtest: normalizes sign and reduces
ok 1 - normalizes sign and reduces
# Subtest: parses decimals exactly
ok 2 - parses decimals exactly
# Subtest: exact arithmetic
ok 3 - exact arithmetic
# Subtest: rejects zero denominator and division by zero
ok 4 - rejects zero denominator and division by zero
# Subtest: weighted average of the most recent k valid samples
ok 1 - weighted average of the most recent k valid samples
# Subtest: missing slots occupy time positions but carry no weight
ok 2 - missing slots occupy time positions but carry no weight
# Subtest: all-zero weights return empty
ok 3 - all-zero weights return empty
# Subtest: effective weights combine time phase and gap distance
ok 4 - effective weights combine time phase and gap distance
# Subtest: deleting a sample changes subsequent windows and adjacent weights
ok 5 - deleting a sample changes subsequent windows and adjacent weights
# Subtest: corrections and deletions match direct fraction recomputation
ok 6 - corrections and deletions match direct fraction recomputation
# Subtest: checkpoint pause/resume carries the unclosed window and source summary
ok 7 - checkpoint pause/resume carries the unclosed window and source summary
# Subtest: resume rejects a tampered or incomplete checkpoint
ok 8 - resume rejects a tampered or incomplete checkpoint
# Subtest: branch corrections keep the old view and match the full resample model
ok 9 - branch corrections keep the old view and match the full resample model
# Subtest: fuzz: incremental series matches direct recomputation on random histories
ok 10 - fuzz: incremental series matches direct recomputation on random histories
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19.076023
```
