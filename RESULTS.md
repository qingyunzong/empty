# RESULTS

Environment: Node.js v22.22.1, Linux x86_64, stdlib only, `node:test` runner.
Command: `node --test` (run on 2026-10-03).

## Summary (real output)

```
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
# Subtest: test/crc32.test.js
ok 2 - test/crc32.test.js
# Subtest: test/enumeration.test.js
ok 3 - test/enumeration.test.js
# Subtest: test/recovery.test.js
ok 4 - test/recovery.test.js
# Subtest: test/store.test.js
ok 5 - test/store.test.js
1..5
# tests 5
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 69030.570065
```

Process exit code: 0. All 5 test files pass; 19/19 individual test cases pass
(per-file runs, real output below).

## Per-file results (real output)

```
=== test/crc32.test.js ===
ok 1 - crc32 known vectors
# tests 1
# pass 1
# fail 0
=== test/store.test.js ===
ok 1 - append three events, reopen, query by deviceId+seq is consistent
ok 2 - duplicate eventId rejected with E_DUP, also after reopen
ok 3 - query orders by seq and isolates devices
ok 4 - validation errors use E_VALIDATION
# tests 4
# pass 4
# fail 0
=== test/recovery.test.js ===
ok 1 - fault point after_data: crashed event is not visible after recovery
ok 2 - fault point after_sync: crashed event is not visible after recovery
ok 3 - fault point after_commit: crashed event IS visible after recovery
ok 4 - event lost in a crash can be re-appended (no phantom E_DUP)
ok 5 - garbage tail bytes are truncated as incomplete
ok 6 - tail CRC error is truncated; earlier committed prefix survives
ok 7 - corrupted commit frame makes its data frame invisible
# tests 7
# pass 7
# fail 0
=== test/enumeration.test.js ===
ok 1 - acceptance 3: all fault prefixes for <=6 records match the reference
# tests 1
# pass 1
# fail 0
=== test/cli.test.js ===
ok 1 - acceptance 1: append 3 events, restart, query by deviceId+seq, dup fails
ok 2 - cli reads JSON events from stdin
ok 3 - acceptance 2: fault point after_data -> event not visible after recover
ok 4 - acceptance 2: fault point after_sync -> event not visible after recover
ok 5 - acceptance 2: fault point after_commit -> event IS visible after recover
ok 6 - cli usage and validation errors are JSON with mapped exit codes
# tests 6
# pass 6
# fail 0
```

## Acceptance coverage

1. **Normal path** (`test/cli.test.js` → "acceptance 1", `test/store.test.js`):
   three events appended via the CLI; after a process restart, `query` by
   `deviceId+seq` returns identical results; re-appending an existing
   `eventId` exits 2 with `{"ok":false,"error":"E_DUP"}`.
2. **Fault points** (`test/cli.test.js` → "acceptance 2", real subprocess
   crashes with exit code 70; `test/recovery.test.js`, in-process injection):
   - `after_data`: data frame written, no sync, no commit → not visible.
   - `after_sync`: data frame synced, no commit → not visible.
   - `after_commit`: commit frame synced → visible.
   Tail CRC corruption and garbage tails are truncated as incomplete
   (`test/recovery.test.js` cases 5–7).
3. **Exhaustive fault-prefix enumeration** (`test/enumeration.test.js`):
   for every n in 1..6 records, every crash position (including none) and all
   three fault points — 69 scenarios — recovered state (primary scan and
   `deviceId`/`deviceId+seq` secondary-index queries) matches the naive
   reference "keep the valid frame prefix, keep only records with a valid
   commit marker in that prefix".

## Notes

- The sandbox used for the test run breaks `spawnSync` stdin pipes (no EOF is
  delivered, even to `/bin/cat`), so CLI tests pass JSON via `--input`; the
  stdin path is verified through a real `bash` pipe
  ("cli reads JSON events from stdin").
