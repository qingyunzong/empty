# Test Results

Command: `node --test` (Node v22.22.1, offline, stdlib + node:test only)
Date: 2026-10-04 — real recorded output, exit code 0.

```
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8863.800659
```

Per-file subtests (run directly, `node <file>`):

| File | Subtests | Pass | Fail | Covers |
|---|---|---|---|---|
| test/validation.test.js | 5 | 5 | 0 | out-of-range, type mismatch, interlock violation, lock/unlock, atomic batch |
| test/rollback.test.js | 3 | 3 | 0 | layer order unlock→params→certs, ROLLBACK on wrong order, phase persists across recovery |
| test/faults.test.js | 5 | 5 | 0 | before/after delta append, before active.json rename, after safe-set commit, clean recovery |
| test/sync.test.js | 5 | 5 | 0 | causal order, deterministic concurrent resolution, safety-critical pending, vector merge, pack→apply→feedback→sync |
| test/enumeration.test.js | 1 | 1 | 0 | n=1..7, all 2^n corrupted subsets × 4 fault points = 1016 crash/recovery cases, compared against brute-force safe-state reference |
| test/cli.test.js | 5 | 5 | 0 | stderr JSON + exit 2 (range & interlock), exit 11 (safety-critical conflict), exit 3 (rollback order), pack→apply→feedback→sync happy path |

Acceptance mapping:

- 越界与联锁: test/validation.test.js, test/cli.test.js (exit 2)
- 回滚顺序: test/rollback.test.js, test/cli.test.js (exit 3)
- 三故障点: test/faults.test.js (+ `before-active-rename`), no half-applied batches, dangerous values safe-set overridden
- n≤7 枚举安全收敛对照: test/enumeration.test.js (1016 cases vs independent reference)
- 安全关键冲突 pending: test/sync.test.js, test/cli.test.js (exit 11)
