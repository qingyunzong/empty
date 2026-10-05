# Actual test results

Recorded: 2026-10-05 10:33:02 UTC
Environment: v22.22.1, npm 9.2.0, tsc Version 7.0.2

## `npm test`

```

> sliding-quantile-store@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/merge.test.js
ok 1 - dist/test/merge.test.js
  ---
  duration_ms: 190.38751
  type: 'test'
  ...
# Subtest: dist/test/treap.test.js
ok 2 - dist/test/treap.test.js
  ---
  duration_ms: 229.916889
  type: 'test'
  ...
# Subtest: dist/test/window.test.js
ok 3 - dist/test/window.test.js
  ---
  duration_ms: 205.097562
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
# duration_ms 246.728328
```

## Per-file subtests

```
== dist/test/merge.test.js ==
ok 1 - clean merge: disjoint corrections combine without conflicts
ok 2 - identical corrections on both sides are not a conflict
ok 3 - conflicting corrections of the same event produce rank bounds
ok 4 - multiple conflicts: enumerate all 2^k choice combinations
ok 5 - resolution publishes atomically; old snapshots stay readable
ok 6 - branches are independently queryable before merging
== dist/test/treap.test.js ==
ok 1 - quantile rank rule: ceil(p*n), p=0 clamps to minimum rank
ok 2 - per-step sorted check: extreme ranks and heavy duplicates
ok 3 - persistence: old roots stay valid after later mutations
== dist/test/window.test.js ==
ok 1 - fixed-size window evicts oldest; duplicates and deletion by event id
ok 2 - event id correction replaces the value in place
ok 3 - empty window returns empty (null) for any quantile
ok 4 - rational p sweep matches the sorted model for n = 1..12
ok 5 - per-step sorted check of sliding window with adds, deletes, corrections
```
