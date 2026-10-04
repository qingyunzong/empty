# Test Results

- Date: 2026-10-04T19:26:56.612Z
- Node: v22.22.1
- Command: npm test (tsc + node scripts/run-tests.mjs)
- Result: PASS (pass=13, fail=0)

## Raw output

```
TAP version 13
# Subtest: commit: all participants vote YES, no crash
ok 1 - commit: all participants vote YES, no crash
  ---
  duration_ms: 8.104471
  type: 'test'
  ...
# Subtest: abort: one participant votes NO, no crash
ok 2 - abort: one participant votes NO, no crash
  ---
  duration_ms: 1.735972
  type: 'test'
  ...
# Subtest: recovery: crash at every persistence point (commit path)
ok 3 - recovery: crash at every persistence point (commit path)
  ---
  duration_ms: 16.541837
  type: 'test'
  ...
# Subtest: recovery: crash at every persistence point (abort path)
ok 4 - recovery: crash at every persistence point (abort path)
  ---
  duration_ms: 9.462273
  type: 'test'
  ...
# Subtest: recovery: repeated crashes at two different points in one run
ok 5 - recovery: repeated crashes at two different points in one run
  ---
  duration_ms: 1.43019
  type: 'test'
  ...
# Subtest: idempotency: duplicate prepare returns persisted vote, logs it once
ok 6 - idempotency: duplicate prepare returns persisted vote, logs it once
  ---
  duration_ms: 0.633255
  type: 'test'
  ...
# Subtest: idempotency: duplicate decision delivery logged once; conflict rejected
ok 7 - idempotency: duplicate decision delivery logged once; conflict rejected
  ---
  duration_ms: 1.459902
  type: 'test'
  ...
# Subtest: idempotency: coordinator log holds one VOTE record per participant after crash
ok 8 - idempotency: coordinator log holds one VOTE record per participant after crash
  ---
  duration_ms: 2.995001
  type: 'test'
  ...
# Subtest: no fake rollback: crash after COMMIT record resumes as COMMIT
ok 9 - no fake rollback: crash after COMMIT record resumes as COMMIT
  ---
  duration_ms: 2.610736
  type: 'test'
  ...
# Subtest: honesty: in-doubt participant reports IN_DOUBT, never ABORTED
ok 10 - honesty: in-doubt participant reports IN_DOUBT, never ABORTED
  ---
  duration_ms: 1.274187
  type: 'test'
  ...
# Subtest: checker: independent verification catches divergent decisions
ok 11 - checker: independent verification catches divergent decisions
  ---
  duration_ms: 1.113538
  type: 'test'
  ...
# Subtest: checker: commit without unanimous YES votes is rejected
ok 12 - checker: commit without unanimous YES votes is rejected
  ---
  duration_ms: 0.497845
  type: 'test'
  ...
# Subtest: cleanup: temp dirs removable
ok 13 - cleanup: temp dirs removable
  ---
  duration_ms: 2.042383
  type: 'test'
  ...
1..13
# tests 13
# suites 0
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 80.326886
```
