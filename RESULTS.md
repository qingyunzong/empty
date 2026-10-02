# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test` runner.
Date: 2026-10-03. Command: `node --test` (full suite, real run output below).

## `node --test` summary (TAP)

```
ok 1 - test/checker.test.js
ok 2 - test/cli.test.js
ok 3 - test/crash.test.js
ok 4 - test/fuzz.test.js
ok 5 - test/helpers.js
ok 6 - test/idempotency.test.js
ok 7 - test/lexer_parser.test.js
ok 8 - test/scenarios.test.js
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15605.01051
```

## `node --test --test-reporter=spec`

```
✔ test/checker.test.js (1950.371598ms)
✔ test/cli.test.js (17806.623079ms)
✔ test/crash.test.js (7643.791634ms)
✔ test/fuzz.test.js (4565.667158ms)
✔ test/helpers.js (1816.647803ms)
✔ test/idempotency.test.js (2666.864013ms)
✔ test/lexer_parser.test.js (2168.209577ms)
✔ test/scenarios.test.js (2619.181909ms)
```

## Acceptance mapping

1. Three scenarios — `test/scenarios.test.js`:
   normal revoke (paired reversal entries, balances net to zero),
   cross-day LOCKED compensation (originals kept, no physical delete),
   PENDING -> CANCEL_REQUESTED (counts as success, balances untouched).
2. Crash after SAVEPOINT — `test/crash.test.js`, `test/cli.test.js`:
   crash injected right after the first SAVEPOINT WAL record, plus a crash
   matrix at every instruction boundary; `recover` output is byte-identical
   to the no-crash reference ledger (also verified through the real CLI in
   a subprocess).
3. Idempotent resubmission — `test/idempotency.test.js`:
   same plan (same revId) re-run on the revoked ledger: all targets
   `skipped`, zero new entries, ledger byte-identical; E_DUP on duplicate
   targets within one batch.
4. Fuzz vs oracle — `test/fuzz.test.js`:
   8 seeds x 50 random txns (SETTLED/PENDING/cross-day-LOCKED), random
   target subsets; VM balances deep-equal the brute-force state-machine
   oracle, and every ledger sums to zero.

## CLI smoke (examples/)

```
$ node bin/rev.js run examples/plan.rvx examples/ledger.json --wal wal.log
{"status":"ok","revId":"rev-2026-0001","counts":{"reversed":1,"compensated":1,"cancelRequested":1,"skipped":0},"balances":{"acct:alice":0,"acct:bob":0,"acct:revenue":0},"out":".../ledger.out.json"}

$ node bin/rev.js recover --wal wal.log
{"status":"ok","revId":"rev-2026-0001","resumed":false,"counts":null,"balances":{"acct:alice":0,"acct:bob":0,"acct:revenue":0},"out":".../ledger.out.json"}
```

Note: `test/helpers.js` is a shared helper module with no assertions; the
runner counts it as a passing file. CLI subprocess tests assert on exit codes
and output files because this sandbox swallows grandchild stdio pipes; CLI
output content is covered by in-process `runCli` tests.
