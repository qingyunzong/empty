# Test Results

Command: `node --test`
Date: 2026-10-03T03:18:00Z (UTC)
Node: v22.22.1

## Summary (real output)

```
ok 1 - test/crash-recovery.test.js
ok 2 - test/enumerate.test.js
ok 3 - test/idempotency-units.test.js
ok 4 - test/out-of-order.test.js
ok 5 - test/watermark-boundary.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 18586.602314
```

## Individual subtests (all passing)

- test/crash-recovery.test.js
  - ok 1 - recovery after kill produces results identical to a clean run
    (includes test-hook abort after N commits and a real SIGKILL mid-run;
    states.jsonl / late.log / proof.json are byte-identical to a clean run,
    and re-running a finished replay is a no-op)
- test/enumerate.test.js
  - ok 1 - exhaustive 2^6 x 2^6 pressure/temperature sequences match reference
    (4096 cases against an independent step-function reference)
  - ok 2 - trip before ARM is not linked, trip at/after ARM is
- test/idempotency-units.test.js
  - ok 1 - duplicate events are idempotent by id
  - ok 2 - sensor without unit reports UNIT_MISSING and is ignored
  - ok 3 - bad json lines are diagnosed, not fatal
- test/out-of-order.test.js
  - ok 1 - late low sample revokes false ARM/TRIP with reverse compensation
  - ok 2 - retracting a suppressing sample restores the earlier ARM
  - ok 3 - sustained over-limit combination proves the trip (positive case)
- test/watermark-boundary.test.js
  - ok 1 - sample exactly at the watermark is processed on time (not late)
  - ok 2 - value exactly equal to the limit does not exceed it
  - ok 3 - condition held for exactly durationMs still ARMs

Result: 5/5 test files, 12/12 subtests passing.
