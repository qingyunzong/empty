# RESULTS — 真实测试运行记录

- 环境：Node.js `v22.22.1`，仅标准库，测试框架 `node:test`
- 命令：`node --test`（仓库根目录）
- 运行日期：2026-10-03

## `node --test` 总览（真实输出）

```
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
# Subtest: test/permutation.test.js
ok 2 - test/permutation.test.js
# Subtest: test/store.test.js
ok 3 - test/store.test.js
# Subtest: test/vector.test.js
ok 4 - test/vector.test.js
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 36579.716521
```

## 逐文件明细（真实输出，21 个测试全部通过）

```
== test/acceptance.test.js
ok 1 - acceptance 1: out-of-order + duplicate ingest yields identical query
ok 2 - acceptance 2: out-of-range correction goes to invalid, never silently dropped
ok 3 - acceptance 3: tombstone blocks resurrection by a stale replica
ok 4 - acceptance 4: visible query is equivalent before and after compact
# tests 4
# pass 4
# fail 0
== test/permutation.test.js
ok 1 - merge: full permutation of 8 sites yields one canonical store
ok 2 - merge: associativity across random groupings (8 sites)
ok 3 - reference: winnerOf matches pairwise tournament under shuffles
ok 4 - compact: preserves visible query; result independent of merge order
ok 5 - merge with a compacted store stays order-independent (6! permutations)
# tests 5
# pass 5
# fail 0
== test/store.test.js
ok 1 - ingest: negative delta is valid, out-of-soft-range is flagged invalid
ok 2 - ingest: BAD_RANGE on hard-range violation, non-finite delta, bad time, bad seq
ok 3 - ingest: duplicate and out-of-order re-ingest is idempotent
ok 4 - query: UNKNOWN_SITE for unregistered site filter
ok 5 - tombstone: ingest put on deleted key raises TOMBSTONE_HIT
ok 6 - tombstone: stale replica cannot resurrect a deleted key via merge
ok 7 - merge: commutative, associative, idempotent on small stores
ok 8 - compact: no-op below min vector, collects covered tombstones, keeps evidence
ok 9 - winnerOf: domination beats concurrency, remove-wins on concurrency
ok 10 - parseStore: BAD_RANGE on malformed lines
# tests 10
# pass 10
# fail 0
== test/vector.test.js
ok 1 - vecLeq / vecEq / vecStrict
ok 2 - vecMax / vecMin
# tests 2
# pass 2
# fail 0
```

## 验收标准映射

| 验收标准 | 验证位置 | 结果 |
| --- | --- | --- |
| 1) 乱序重复 ingest 后 query 一致 | `test/acceptance.test.js` acceptance 1；`test/store.test.js` #3 | 通过 |
| 2) 越界订正进入 invalid 而非静默丢弃 | `test/acceptance.test.js` acceptance 2；`test/store.test.js` #1 | 通过 |
| 3) tombstone 阻止旧站复活 | `test/acceptance.test.js` acceptance 3；`test/store.test.js` #5/#6 | 通过 |
| 4) compact 前后可见查询等价 | `test/acceptance.test.js` acceptance 4；`test/permutation.test.js` #4 | 通过 |
| merge 交换/结合/幂等（≤8 站点全排列参考验证） | `test/permutation.test.js` #1（8 站点 40320 全排列）、#2、#5 | 通过 |

## 备注

- 全排列验证：8 站点 × 每站 5 事件（含越界、负值、删除、跨站 key、并发向量），
  40320 种合并顺序产生逐字节相同的规范化 store。
- 参考交叉验证：`winnerOf`（候选集构造）与独立的成对锦标赛实现在 50 种随机
  打乱下结果一致。
