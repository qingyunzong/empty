# Test Results (real run)

- Command: `node --test`
- Runtime: Node.js v22.22.1, linux x64, offline, stdlib + node:test only
- Date (UTC): 2026-10-05T21:17:41Z
- Verdict: **exit 0 — 6/6 test files passed, 0 failed** (14,163 ms)

```
# tests 6
# pass 6
# fail 0
```

## Per-file

| File | Result | Subtests |
|---|---|---|
| test/session.test.js | ok | 5/5 |
| test/recovery.test.js | ok | 3/3 |
| test/sync.test.js | ok | 3/3 |
| test/merge-enum.test.js | ok | 2/2 |
| test/cli.test.js | ok | 5/5 |

## Acceptance coverage

- 负库存边界: "negative inventory boundary: down to zero ok, below zero rejected" — ok
- 关闭后写入: "writes after close report CLOSED (exit 3)" — ok
- 三故障点: "crash before scan persisted" / "crash before session tmp rename" / "crash after ledger commit" — all ok
- n≤8 枚举: "n<=8: all merge orders converge to the single legal result" — ok

## Enumeration diagnostics (from merge-enum.test.js)

Legal-result enumeration (initial stock 2, deltas [3,-2,1,-4,5,-3,2,-1]):

```
# n=1: 1 orders -> 1 legal result (qty=5)
# n=2: 2 orders -> 1 legal result (qty=3)
# n=3: 6 orders -> 1 legal result (qty=4)
# n=4: 24 orders -> 1 legal result (qty=0)
# n=5: 120 orders -> 1 legal result (qty=5)
# n=6: 720 orders -> 1 legal result (qty=2)
# n=7: 5040 orders -> 1 legal result (qty=4)
# n=8: 40320 orders -> 1 legal result (qty=3)
```

Negative-aggregate enumeration (extra -100 op; must stay pending, never fail, never negative):

```
# n=2: 6 orders -> -100 always pending
# n=3: 24 orders -> -100 always pending
# n=4: 120 orders -> -100 always pending
# n=5: 720 orders -> -100 always pending
# n=6: 5040 orders -> -100 always pending
# n=7: 40320 orders -> -100 always pending
# n=8: 362880 orders -> -100 always pending
```

## Environment note

This sandbox intermittently reports EPERM on grandchild pipe capture, so
test/cli.test.js captures CLI stdout/stderr via temp files instead of pipes
(see `run()` in test/cli.test.js). CLI behavior itself is unaffected.
