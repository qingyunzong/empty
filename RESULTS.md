# Test Results

- Date (UTC): 2026-10-02T19:58:18Z
- Node: v22.22.1
- Command: `node --test`

## Summary (real output)

```
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8664.179438
```

## Subtests (all passing, 12/12)

test/engine.test.js:
- ok 1 - watermark boundary: sample exactly at watermark is on-time, below is late (acceptance 2)
- ok 2 - threshold equality: value exactly == limit does not ARM, limit+1 does (acceptance 2)
- ok 3 - sustained combination ARMs after holdMs; jitter does not
- ok 4 - retract restores an alarm that was suppressed by a normal sample
- ok 5 - sensor without unit throws UNIT_MISSING
- ok 6 - enumeration: random pressure/temperature/trip sequences match reference (acceptance 3, 300 seeded cases)
- ok 7 - enumeration: arrival order does not change derived transitions

test/replay.test.js:
- ok 1 - out-of-order late sample revokes false ARM/TRIP with compensation (acceptance 1)
- ok 2 - CLI exits 2 with UNIT_MISSING when a sensor lacks unit
- ok 3 - duplicate event ids are applied exactly once
- ok 4 - kill -9 mid-run then restart converges to the clean-run result (acceptance 4)
- ok 5 - recovery is idempotent when the last batch is replayed after a kill

## Acceptance mapping

1. Out-of-order false TRIP revoked: test/replay.test.js "out-of-order late
   sample revokes false ARM/TRIP with compensation" — states.jsonl contains
   COMPENSATE records revoking `TRIP:CH1@3500` and `ARM@3000`; corrected
   ARM@5000/TRIP@5000 appended.
2. Watermark/threshold boundary: test/engine.test.js tests 1-2 — a sample at
   exactly maxEventTs-lag is on-time; a value exactly == limit does not ARM
   (strict `>`).
3. Small-case enumeration: test/engine.test.js test 6 — 300 seeded random
   pressure/temperature/trip sequences compared against an independent
   reference implementation.
4. Kill recovery: test/replay.test.js test 4 — SIGKILL after committed
   snapshots, restart resumes from snapshot.json; states.jsonl, proof.json
   and late.log are byte-identical to a clean run.
