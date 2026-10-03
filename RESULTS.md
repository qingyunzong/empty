# RESULTS

- Command: `node --test`
- Date (UTC): 2026-10-03T06:13:47Z
- Node: v22.22.1 (standard library only, `node:test`)
- Exit code: 0

## Summary (actual output)

```
ok 1 - test/fuzz.test.js
ok 2 - test/lexer.test.js
ok 3 - test/parser.test.js
ok 4 - test/recovery.test.js
ok 5 - test/types.test.js
ok 6 - test/vm.test.js
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 28472.389913
```

6 test files / 32 subtests, all passing (0 failures).

## Acceptance coverage

1. **Three reversal scenarios** (`test/vm.test.js`, 8 subtests):
   same-day SETTLED voided physically; cross-day LOCKED compensated
   (originals kept, mirrored legs dated today); PENDING marked
   `CANCEL_REQUESTED` with nothing posted.
2. **Crash after SAVEPOINT** (`test/recovery.test.js`): clean reference
   run, then `REV_CRASH_AT_EFFECT=k` for every k in 1..4 (crash exit code
   3, right after the k-th effect is WAL-logged). `rev recover` after each
   crash produces a ledger byte-identical to the no-crash reference.
3. **No double reversal** (`test/recovery.test.js` + `test/vm.test.js`):
   re-`run` with a committed WAL is an idempotent no-op; a duplicate
   submission with a fresh WAL is rejected by the idempotency guard
   (`error[E_DUP] txn=1001 pc=7`); ledger balances verified unchanged.
4. **Random 50-txn ledgers vs brute-force state machine**
   (`test/fuzz.test.js`): 5 seeds x 50 random txns; VM balances and status
   counts deep-equal the independent brute-force reference; double-entry
   invariant (balances sum to 0) holds.

## Error codes observed in tests

- `E_STATE txn=1004 pc=7` — reversing a FAILED txn
- `E_LOCK pc=4` — moving funds out of a frozen account
- `E_DUP txn=1001 pc=7` — duplicate reversal submission
- `E_IO` — missing WAL / unreadable ledger
- `E_PARSE` / `E_TYPE` — lexer/parser/static-checker rejections
