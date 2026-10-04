# RESULTS

Recorded from a real run on this workspace.

- Runtime: `node --version` → `v22.22.1`
- Command: `node --test`
- Date: 2026-10-04

## `node --test` summary (real output)

```
ok 1 - test/cli.test.js
ok 2 - test/correction.test.js
ok 3 - test/crash.test.js
ok 4 - test/errors.test.js
ok 5 - test/idempotency.test.js
ok 6 - test/recovery.test.js
# tests 6
# pass 6
# fail 0
```

Per-file subtest counts (each file also run directly, all passing, 18 subtests total):

| file | subtests | pass | fail |
| --- | --- | --- | --- |
| test/cli.test.js | 4 | 4 | 0 |
| test/correction.test.js | 3 | 3 | 0 |
| test/crash.test.js | 3 | 3 | 0 |
| test/errors.test.js | 5 | 5 | 0 |
| test/idempotency.test.js | 2 | 2 | 0 |
| test/recovery.test.js | 1 | 1 | 0 |

## Acceptance coverage

1. **Idempotent report** — `test/idempotency.test.js`: the same
   `clientRecordId` reported twice (also across a restart) yields one
   committed WAL record, one certificate, one state entry; a conflicting
   payload is rejected with `ERR_CLIENT_ID_CONFLICT`.
2. **Correction OK → NG** — `test/correction.test.js`: latest judgment,
   `(lotId,testCode)` index head and certificate chain (`prevHash` linkage)
   update; the old certificate still verifies independently
   (`verifyCertificateData` on the standalone cert file).
3. **Crash points** — `test/crash.test.js` and `test/cli.test.js`: faults
   injected at `after-data-sync` (uncommitted → no judgment, retry allowed)
   and `after-commit-sync` (committed → survives, dedups on retry); recovery
   state equals the naive "replay valid committed records by sequence number"
   oracle in `src/reference.js` (`test/recovery.test.js` rechecks this after
   a mixed workload and repeated restarts).

## CLI exit codes (verified in `test/cli.test.js` and a manual smoke run)

- `0` success, JSON state on stdout
- `1` business error (`ERR_VALUE_OUT_OF_RANGE`, `ERR_UNKNOWN_TEST`,
  `ERR_UNKNOWN_REFERENCE`, `ERR_NOT_INITIALIZED`, ...), JSON error on stderr
- `2` corruption (`ERR_CORRUPT`, e.g. tampered committed WAL record)
- `3` injected crash via `QCS_FAULT=after-data-sync|after-commit-sync`
