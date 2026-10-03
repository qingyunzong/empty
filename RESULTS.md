# Test Results

Date: 2026-10-03 04:33:11 UTC  (local: 2026-10-03 12:33:11 CST)
Node: v22.22.1
Command: `node --test`

## Summary (node --test)

- tests 2
- suites 0
- pass 2
- fail 0
- cancelled 0
- skipped 0
- todo 0
- duration_ms 3613.746111

## Per-test results

```
# test/engine.test.js
ok 1 - calib retraction cascades OK -> VOID and recovery keeps all versions
ok 2 - late scan (behind watermark) is logged and flips HOLD -> OK
ok 3 - missing lot yields HOLD without errors
ok 4 - duplicate id with conflicting payload reports DUP_EVENT and keeps first
ok 5 - identical duplicate id is an idempotent no-op
ok 6 - illegal angle reports ANGLE_RANGE and is disqualified
ok 7 - multiple tightenings: last qualified event wins, ties by (eventTs, id)
ok 8 - scan retraction voids the cert, a replacement scan recovers it
ok 9 - scan outside the +-500ms window does not certify
ok 10 - calib validity interval must cover the tightening eventTs
ok 11 - exhaustive subset enumeration matches oracle certificates

# test/cli.test.js
ok 1 - trace certify writes certs.jsonl, void.jsonl, late.log
ok 2 - cli reports DUP_EVENT in errors.jsonl and still exits 0
ok 3 - cli rejects unknown arguments with exit code 2
ok 4 - output dirs are created and files exist even when empty
```

All 15 tests pass (11 engine + 4 CLI), including the four acceptance criteria:

1. calib retraction cascades OK -> VOID (engine test 1, cli test 1)
2. late scan flips HOLD -> OK (engine test 2, cli test 1)
3. exhaustive subset enumeration vs oracle, 2^6 = 64 subsets (engine test 11)
4. duplicate id conflict reports DUP_EVENT (engine test 4, cli test 2)
