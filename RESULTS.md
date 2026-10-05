# RESULTS

运行时间：2026-10-05 14:58:02 CST，Node v22.22.1

## `node --test`

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 594.175885
```

## `node --test-reporter=spec test/graph.test.js`

```
✔ acceptance 1: incremental reweight keeps path and cost correct (13.888406ms)
✔ acceptance 2: closure with detour differs from true disconnection (2.350119ms)
✔ lexicographic tie-break among equal-cost paths is stable (0.875609ms)
✔ acceptance 4: three consecutive undos restore state three layers back (2.749114ms)
✔ undo does not touch committed query results (1.956589ms)
✔ acceptance 5: tampered, stale or foreign certificates always fail (7.003757ms)
✔ input validation and conflict error codes (1.320394ms)
✔ query to self has zero cost and a valid certificate (1.048851ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 60.147839
```

## `node --test-reporter=spec test/exhaustive.test.js`

```
✔ acceptance 3: all-pairs queries match brute-force enumeration (n<=8) (98.201214ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 119.949423
```

## `node --test-reporter=spec test/cli.test.js`

```
✔ CLI processes a full JSONL session end to end (12.706713ms)
✔ CLI verify accepts genuine certs and rejects forged ones (7.60301ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 48.848936
```

