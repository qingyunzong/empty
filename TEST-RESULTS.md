# 实际测试结果（npm test）

记录时间：2026-10-05 03:41:14 CST，Node v22.22.1，tsc 7.0.2

```

> perm-merge@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/model.test.js
ok 1 - dist/test/model.test.js
  ---
  duration_ms: 739.678599
  type: 'test'
  ...
# Subtest: dist/test/semantics.test.js
ok 2 - dist/test/semantics.test.js
  ---
  duration_ms: 450.754884
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
# duration_ms 768.36628
```

## 用例明细

```
ok 1 - concurrent grant and revoke of the same permission -> revoke wins
ok 2 - causally-later grant restores a revoked permission
ok 3 - causally-later revoke wins over an earlier grant
ok 4 - grant -> revoke -> grant chain: only the last grant survives
ok 5 - out-of-order and duplicated delivery converges to the same state
ok 6 - state-based merge converges both ways
ok 7 - causal version, not wall clock, decides the outcome
ok 8 - provenance: effective permission reports its surviving grant sources
ok 9 - independent permissions do not interfere
ok 1 - random histories: out-of-order delivery matches the partial-order model
ok 2 - random histories: pairwise state merge converges to the model
ok 3 - model sanity: hand-built remove-wins and restore cases
```
