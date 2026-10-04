# 实际测试结果记录

- 日期：2026-10-05
- 环境：Node.js v22.22.1，npm 9.2.0，TypeScript Version 7.0.2
- 命令：`npm test`（`tsc -p tsconfig.json && node --test dist/test/*.test.js`）

## npm test 输出

```

> dag-boundary-bisect@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/bisect.test.js
ok 1 - dist/test/bisect.test.js
  ---
  duration_ms: 463.066008
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
# duration_ms 487.891545
```

## 逐用例明细（node dist/test/bisect.test.js）

```
ok 1 - linear chain with monotonic failure finds the first bad version
ok 2 - non-monotonic results yield multiple boundary versions
ok 3 - bad version with a bad parent is not on the boundary
ok 4 - root versions have no parents and are boundary when bad
ok 5 - detector exceptions become pending and block confirmation downstream
ok 6 - budget exhaustion keeps the untested set and a prefix-closed tested set
ok 7 - zero budget tests nothing
ok 8 - evidence records queries in topological order
ok 9 - full-DAG scan agrees with bounded run when budget covers all nodes
ok 10 - cross-check explains misses caused by budget and pending
ok 11 - cross-check flags unexplained misses
ok 12 - cross-check flags false positives against full-DAG truth
ok 13 - withFailures adapter marks flaky versions pending
ok 14 - buildDag rejects cycles and self-loops
ok 15 - seeded random DAGs: bounded run with full budget matches full scan
# tests 15
# pass 15
# fail 0
```

## CLI 演示（examples/non-monotonic.json，budget=4）

```json
{
  "bounded": {
    "budget": 4,
    "queriesUsed": 4,
    "status": {
      "v1": "good",
      "v2": "bad",
      "v3": "good",
      "v4": "bad"
    },
    "confirmedBoundary": [
      "v2"
    ],
    "unresolvedBoundary": [],
    "untested": [
      "v6",
      "v5"
    ],
    "evidence": [
      {
        "seq": 1,
        "version": "v1",
        "outcome": "good"
      },
      {
        "seq": 2,
        "version": "v2",
        "outcome": "bad"
      },
      {
        "seq": 3,
        "version": "v3",
        "outcome": "good"
      },
      {
        "seq": 4,
        "version": "v4",
        "outcome": "bad"
      }
    ],
    "complete": false
  },
  "fullBoundary": [
    "v2",
    "v6"
  ],
  "fullStatus": {
    "v1": "good",
    "v2": "bad",
    "v3": "good",
    "v4": "bad",
    "v6": "bad",
    "v5": "pending"
  },
  "crossCheck": {
    "ok": true,
    "issues": [],
    "confirmed": [
      "v2"
    ],
    "explainedMisses": [
      {
        "version": "v6",
        "reason": "untested"
      }
    ]
  }
}
```
