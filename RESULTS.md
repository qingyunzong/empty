# RESULTS

## `node --test`（真实输出，TAP 摘要）

```
TAP version 13
# Subtest: test/planner.test.js
ok 1 - test/planner.test.js
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2481.418843
```

## 子测试明细（`node test/planner.test.js`）

```
ok 1 - chain schedule: sequential start/end and makespan
ok 2 - parallel schedule: independent tasks overlap, makespan is critical path
ok 3 - same-start tie breaks by id lexicographically when durations equal
ok 4 - cycle compresses to SCC and stays orderable with external nodes
ok 5 - self loop is reported as a cycle
ok 6 - budget boundary: exact total cost feasible, one less is INFEASIBLE
ok 7 - three-level group rollback restores deps, cost and committed flags
ok 8 - random DAGs (n<=9) match topological enumeration and yield valid orders
ok 9 - invalid inputs are rejected
ok 10 - duplicate dep is idempotent
ok 11 - CLI processes JSONL commands end to end
ok 12 - CLI reports CYCLE with SCCs and suggestions
```
