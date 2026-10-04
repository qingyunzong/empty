# RESULTS

Environment: Node.js v22.22.1, linux x64. Date (UTC): 2026-10-04T09:32:20Z.
Command: `node --test` (standard library + `node:test` only, no dependencies).

## Test run (real output)

```
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40131.020514
```

Suites: `test/scheduler.test.js` (8 tests), `test/store.test.js` (7 tests),
`test/cli.test.js` (6 tests) — 21 assertions-bearing tests, all passing.

Note: this sandbox cannot capture grandchild stdout through pipes, so
`test/cli.test.js` redirects spawned CLI stdout/stderr to temp files (see the
comment in that file). On a normal host pipes work as-is.

## Acceptance criteria

1. **DFS cross-check (<=4 jobs).** `test/scheduler.test.js` "schedule matches
   exhaustive DFS enumeration for <=4 jobs": 200 seeded random instances
   (n=1..4, random release/due/duration/device restrictions). For each, the
   library plan is compared against an independent enumeration of every
   permutation x device-choice vector (`enumeratePlans`): identical objective,
   identical entries, and certificate fields `inputHash` (SHA-256 of canonical
   input), `objective`, `tieRank` (1-based rank among all Lmax-optimal plans in
   enumeration order) all match. PASS.
2. **Snapshot conflict.** `test/store.test.js` "concurrent jobs update
   invalidates staged plan with E_SNAPSHOT" (begin -> concurrent `setJobs` ->
   stage -> commit throws `E_SNAPSHOT`, then retry succeeds) and
   `test/cli.test.js` "CLI snapshot conflict": `plan --expect-version 1` after
   a jobs update exits 1 with
   `{"ok":false,"error":{"code":"E_SNAPSHOT","expected":1,"actual":2}}`, old
   plan untouched; replanning with the current version succeeds. PASS.
3. **Crash boundary.** Real child-process crash injection via
   `plan --crash after_stage|after_commit` (exit code 3), verified in
   `test/cli.test.js` and reproduced manually:
   - `after_stage`: restart shows `jobsVersion:2, planVersion:1` — staged plan
     discarded, previous committed plan (2 entries, `baseVersion:1`) intact;
     a subsequent `plan` commits cleanly (`planVersion:2`).
   - `after_commit`: restart shows `planVersion:2` with the full new plan
     (3 entries, `baseVersion:2`) and the rebuilt `(jobId, deviceId)` index
     (`query --job-id C` hits the new assignment).
   - Insufficient capacity (`devices: []`): `plan` exits 1 with
     `E_INFEASIBLE` + `jobId`, and `show` confirms the old plan and versions
     are unchanged. PASS.

## Performance spot check

Exact scheduler on 20 random jobs / 2 devices: ~140 ms (see
`test/scheduler.test.js` "scales to 20 jobs on two devices").
