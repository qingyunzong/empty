# RESULTS

- Date: 2026-10-03
- Runtime: Node.js v22.22.1 (standard library only, `node:test`)
- Command: `node --test`

## Summary

```
✔ test/a-state-machine.test.js
✔ test/b-nulls-currency.test.js
✔ test/c-incremental-stats.test.js
✔ test/cli.test.js
✔ test/d-settlement-lock.test.js
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

19 individual tests, 19 passed, 0 failed (real output of `node --test`).

## Acceptance criteria

### A — State machine legal/illegal transitions (`test/a-state-machine.test.js`)
- `ok` A: legal full-path transitions — auth→capture→refund→reverse→capture→chargeback→reverse_chargeback→capture, auth→void
- `ok` A: illegal transitions raise E_TRANSITION — every edge not in the transition table, incl. double refund-reverse
- `ok` A: terminal state is immutable — `voided` rejects all 6 operations, state unchanged
- `ok` A: unknown id and duplicate auth — E_NOT_FOUND / E_VALIDATION

### B — NULL tip & unknown currency (`test/b-nulls-currency.test.js`)
- `ok` B: NULL tip is ignored in fee aggregation — tipSum/tipCount skip NULL and omitted tips
- `ok` B: NULL amount ignored by min/max/sum but capture counted
- `ok` B: unknown currency is not converted and gets its own bucket — XTS and NULL currency (`UNKNOWN` bucket) excluded from USD-converted total

### C — Incremental stats vs brute force, 5000 events (`test/c-incremental-stats.test.js`)
- `ok` C: incremental materialized stats match brute-force scan over 5000 events (seeded, reproducible; all merchant×day cells compared with deepEqual)
- `ok` C: recomputeDay repairs a corrupted materialized bucket
- `ok` C: rollbackTo(day) replays prefix and matches a fresh ledger
- `ok` C: rollback drops causal dependents of events beyond the cut day

### D — Settlement lock (`test/d-settlement-lock.test.js`)
- `ok` D: reversing a chargeback on a settled capture fails with E_LOCKED and no side effects (state, stats, log, lock table verified unchanged)
- `ok` D: lock boundary is inclusive and explicit — capture day `<= lockedThrough` is locked, later captures reversible until settlement extends
- `ok` D: settlement lock is per-merchant

### CLI (`test/cli.test.js`)
- `ok` CLI: apply events and print merchant stats — `card apply events.jsonl --stats m d`
- `ok` CLI: illegal transition exits non-zero with `{"code","message"}` on stderr, stdout empty
- `ok` CLI: malformed JSONL line reports E_PARSE with line number
- `ok` CLI: settlement-locked chargeback reversal fails via CLI (E_LOCKED)
- `ok` CLI: usage errors exit non-zero (E_USAGE; unreadable file → E_VALIDATION)

Note: the sandbox forbids spawning child processes (EPERM), so CLI tests drive
`src/cli.js` in-process through injectable IO; `bin/card.js` is a thin wrapper
and was verified manually:

```
$ node bin/card.js apply /tmp/bad.jsonl
{"code":"E_TRANSITION","message":"txn t1: cannot apply \"refund\" in state \"auth\""}
exit=1
```
