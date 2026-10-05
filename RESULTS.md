# 实际测试结果

记录时间：2026-10-05 11:14:41 CST
环境：v22.22.1, npm 9.2.0, tsc Version 7.0.2（全局）

## `npm test` 完整输出

```

> merge3@0.1.0 test
> tsc && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 2883.66327
  type: 'test'
  ...
# Subtest: dist/test/diff.test.js
ok 2 - dist/test/diff.test.js
  ---
  duration_ms: 488.471923
  type: 'test'
  ...
# Subtest: dist/test/merge.test.js
ok 3 - dist/test/merge.test.js
  ---
  duration_ms: 416.778589
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
# duration_ms 2902.896133
```

## 各测试文件子项（逐文件运行 `node <file>` 的 TAP 摘要）

```
== dist/test/cli.test.js ==
ok 1 - clean merge exits 0 and writes the merged document
ok 2 - conflicting merge exits 1 and emits markers preserving both branches
ok 3 - --json writes a reversible result; revert reconstructs all three inputs
ok 4 - revert reads the merged document from stdin when --merged is omitted
ok 5 - custom labels are used in conflict markers
ok 6 - usage errors exit 2
== dist/test/diff.test.js ==
ok 1 - diff of identical documents is empty
ok 2 - insertion, deletion and replacement hunks carry base line numbers
ok 3 - short documents: diff matches brute-force enumeration of all edit combinations
ok 4 - myers path agrees with exhaustive path on randomized inputs
ok 5 - myers handles empty sides
== dist/test/merge.test.js ==
ok 1 - adjacent but non-overlapping edits from both sides merge cleanly
ok 2 - directly touching (adjacent) ranges from both sides merge cleanly
ok 3 - different insertions at the same point conflict
ok 4 - identical insertions at the same point merge once
ok 5 - identical replacements on both sides merge once
ok 6 - overlapping different edits conflict and preserve the original branch ranges
ok 7 - insertion strictly inside the other side's replaced range conflicts
ok 8 - insertion at the boundary of the other side's edit merges cleanly
ok 9 - revert reconstructs every side from merged text + result
ok 10 - revert rejects a tampered merged text
ok 11 - randomized round-trip: merge then revert yields all three inputs
ok 12 - mergeLines keeps hunks sorted by base line number
```
