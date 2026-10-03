# RESULTS

Environment: Node.js v22.22.1, standard library only, test runner `node:test`.

Command: `node --test`

## Summary (real output)

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
# Subtest: test/ledger.test.js
ok 2 - test/ledger.test.js
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Per-test detail (real output)

`node test/ledger.test.js`:

```
ok 1 - A: reverse appends a compensating entry and never mutates history
ok 2 - A: repeating reverse of the same id is idempotent and returns the original compensation seq
ok 3 - A: reverse of unknown id or settled period raises E_STATE
ok 4 - B: crash before fsync (after write) recovers to committed prefix only
ok 5 - B: crash after fsync but before commit marker recovers to committed prefix only
ok 6 - B: crash on the very first entry recovers to an empty ledger
ok 7 - C: balance(asOfSeq) matches brute-force replay across 200 random histories
ok 8 - C: asOfSeq queries hit checkpoint boundaries without full scans
ok 9 - D: negative balance policy is configurable and rejections leave no residue
ok 10 - D: duplicate post id raises E_STATE without residue
# tests 10
# pass 10
# fail 0
```

`node test/cli.test.js`:

```
ok 1 - CLI: apply then balance round-trip
ok 2 - CLI: apply is idempotent for repeated reverse across invocations
ok 3 - CLI: errors exit non-zero with {code,message} on stderr
ok 4 - CLI: --no-negative rejects overdraft with E_STATE and keeps ledger intact
# tests 4
# pass 4
# fail 0
```

## Acceptance mapping

- A (reversal idempotency): tests 1-3 in `test/ledger.test.js`; history is never mutated,
  repeat `reverse(id)` returns the original compensation seq, unknown id and settled
  periods raise `E_STATE`.
- B (crash injection): tests 4-6 inject crashes via `hooks.afterWrite` (before fsync)
  and `hooks.afterFsync` (after fsync, before commit marker); recovery truncates the
  uncommitted tail of `data.log` and state equals the committed prefix.
- C (asOfSeq correctness): test 7 compares `balance(account, asOfSeq)` against
  brute-force replay for 200 seeded random histories (random checkpoint intervals,
  posts and reversals); test 8 checks checkpoint-boundary queries.
- D (negative balance policy): tests 9-10 cover `allowNegative: false` rejections
  (`E_STATE`) leaving no residue in memory, in `data.log`, or after recovery.

## Notes

- CLI tests call `runCli()` in-process because this sandbox blocks `spawnSync`
  (EPERM on grandchild processes). `bin/ledger.js` is a thin wrapper and was
  verified standalone: `ledger apply ops.jsonl --dir D` prints
  `{"line":1,"seq":1,"idempotent":false}` and exits 0.
