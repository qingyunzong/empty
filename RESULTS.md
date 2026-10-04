# Recorded test results

Command: `node --test` (Node v22.22.1, linux x64), run on 2026-10-04.

## Suite-level output (real)

```
TAP version 13
ok 1 - test/cli.test.js
ok 2 - test/helpers.js
ok 3 - test/recovery.test.js
ok 4 - test/session.test.js
ok 5 - test/sync.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# duration_ms 40153.046252
exit code: 0
```

## Per-file detail (real, `node <file>`)

```
== test/session.test.js ==
ok 1 - begin/scan/adjust/close aggregates by bin+item
ok 2 - duplicate begin is rejected
ok 3 - barcode format validation
ok 4 - quantity must be a positive integer for scan, non-zero integer for adjust
ok 5 - scan/adjust after close report CLOSED
ok 6 - negative inventory boundary: exact zero closes, one below fails
ok 7 - undo only allowed for unclosed sessions
ok 8 - undo on empty session fails
== test/recovery.test.js ==
ok 1 - fault 1: crash before scan is persisted -> scan is lost, rescan works
ok 2 - fault 2: crash before session tmp rename -> tmp discarded, WAL replayed once
ok 3 - fault 3: crash after ledger commit -> ledger kept, close finalized once
ok 4 - resume is idempotent
ok 5 - cursor tracks the processed WAL offset across scans
== test/sync.test.js ==
ok 1 - two terminals converge bidirectionally with merged version vectors
ok 2 - concurrent adjusts on the same item merge commutatively
ok 3 - merge causing negative inventory goes to pending instead of failing
ok 4 - three terminals converge regardless of sync order
ok 5 - n<=8: enumerate every merge order, all legal results are identical
ok 6 - n=8 pending set is deterministic and explainable
== test/cli.test.js ==
ok 1 - happy path: begin -> scan -> close -> verify
ok 2 - exit 2 with JSON stderr on validation and usage errors
ok 3 - exit 3 with JSON stderr on state errors (CLOSED)
ok 4 - exit 10 on verify divergence, 0 after sync
ok 5 - resume command reports recovery as JSON
```

Totals: 24 tests, 24 pass, 0 fail.

The n<=8 enumeration folds merges in all n! orders for n = 2..8
(46,232 orders, 362,878 merges) and asserts a single canonical result per n;
for n = 8 the converged stock is 2 with pending nodes n4..n7 (deterministic
eviction, largest node id first).
