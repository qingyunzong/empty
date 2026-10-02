# RESULTS

- Environment: Node.js v22.22.1, standard library only, `node:test` runner
- Command: `node --test`
- Date (UTC): 2026-10-02

## Summary

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

All 6 test files (19 subtests) pass.

## Per-file results

```
ok 1 - test/apportion-brute.test.js
ok 2 - test/apportion.test.js
ok 3 - test/budget.test.js
ok 4 - test/cli.test.js
ok 5 - test/revoke.test.js
ok 6 - test/settled.test.js
```

## Acceptance criteria

- **A — two-level revoke restores original discount**
  (`test/revoke.test.js`): PASS
  - `two-level revoke cascades and restores original discount, tax and points`:
    revoking `r1` rolls back child `r2` first (`rolledBack: ["r2","r1"]`),
    `consumedDiscount` 150 -> 0, clawed points 30 -> 0, lines refundable again.
  - `settled child blocks parent revoke: E_ROLLBACK_PATH, subtree untouched`:
    child settled -> `E_ROLLBACK_PATH` with `path: ["r1","r2"]`; discount,
    points, refunded-lines and record log verified unchanged (no partial
    rollback).
- **B — budget boundary equal/exceed** (`test/budget.test.js`): PASS
  - 600 + 400 == limit 1000 accepted; +1 cent rejected with
    `E_BUDGET_EXCEEDED`; usage stays exactly 1000, no refund record created,
    no lines consumed (no partial deduction). Revoke/reversal release budget;
    periods aggregate independently.
- **C — tie apportionment vs brute force** (`test/apportion-brute.test.js`):
  PASS — 300 seeded random small orders (1–5 lines, heavy amount ties):
  `apportion()` matches an independent brute-force enumeration of all
  remainder-recipient subsets (lexicographically smallest subset of lineIds),
  and is stable under input shuffling.
- **D — settled revoke errors but generates optional reverse flow**
  (`test/settled.test.js`, `test/cli.test.js`): PASS
  - Library: settled revoke -> `E_ALREADY_SETTLED`; with `reverse: true` a
    reversal record (negated amounts, `parentRefId`) is emitted and budget is
    released; double reversal -> `E_ALREADY_REVERSED`.
  - CLI: exit code != 0, stderr `{"code":"E_ALREADY_SETTLED",...}`, reversal
    JSON present on stdout.

## CLI verification

`node src/cli.js apply ops.example.jsonl --as-of 2026-02-01` prints budget,
two refunds, a hierarchical revoke and a reversal record on stdout, then
`{"code":"E_ALREADY_SETTLED",...}` on stderr; exit code 1. Error paths
(`E_USAGE`, `E_IO`, `E_INVALID_DATE`, `E_INVALID_OP`, `E_BUDGET_EXCEEDED`)
verified in `test/cli.test.js` with non-zero exit and `{code,message}` JSON
on stderr.
