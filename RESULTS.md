# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test`, single machine, offline.
Date of run: 2026-10-04T09:35Z. Command: `node --test` (exit code 0).

## Test run (real output, `node --test`)

```
ok 1 - test/a-normal.test.js
ok 2 - test/b-error-repair.test.js
ok 3 - test/c-batch.test.js
ok 4 - test/cli.test.js
ok 5 - test/d-enumeration.test.js
ok 6 - test/e-recovery.test.js
ok 7 - test/undo.test.js
# tests 7
# pass 7
# fail 0
# duration_ms 13321.613356
```

27 individual assertions-bearing tests across 7 files, all passing.

## Acceptance criteria

- **A — normal debit/credit/hold/release** (`test/a-normal.test.js`, 3 tests, PASS):
  open 100 -> debit 30 -> credit 20 -> hold 25 -> release 10 -> release 15 -> commit;
  final `{state: OPEN->COMMITTED, balance: 90, held: 0}`. Hold freezes funds
  (debit against fully-held balance -> NEGATIVE); commit with outstanding hold
  -> HOLD_LEAK + ERROR.
- **B — overdraft -> ERROR, repair recovers** (`test/b-error-repair.test.js`, 2 tests, PASS):
  debit 80 of 50 -> NEGATIVE, account enters ERROR with balance untouched (50);
  debit/credit/commit/open while in ERROR -> ILLEGAL_TRANSITION; `repair` ->
  OPEN; subsequent debit 40 succeeds (balance 10).
- **C — 3-level batch, level-2 failure rolls back locally** (`test/c-batch.test.js`, 3 tests, PASS):
  L1(credit 10) > L2(debit 30 > L3(credit 5, ok)) then L2 debit 200 -> NEGATIVE.
  `endBatch(L2)` rolls back only L2's subtree (balance back to 110, events
  e2/e3 removed from history, head restored to e1); parent L1 continues
  (credit 7) and commits: final balance 117. Variant with
  `onChildFailure: 'abort'` cascades: whole tree rolled back to balance 100.
  Repeated runs produce identical state (determinism asserted).
- **D — exhaustive enumeration, <= 12 events, 3 accounts** (`test/d-enumeration.test.js`, PASS):
  BFS over the joint state space of accounts a/b/c, ops
  open/debit/credit/hold/release/commit/void/repair, amount 10, open balance 20,
  balance cap 20, depth <= 12. Every edge is applied to a cloned `Ledger` and
  compared against an independent reference model (including error-code
  agreement for illegal edges). Real diagnostic from the run:
  `verified 155772 event edges (125472 error edges) across 6859 reachable joint states, depth <= 12`.
- **E — crash recovery at the three fault points** (`test/e-recovery.test.js`, 9 tests, PASS):
  - `beforeEvent`: journal unchanged, recovers to previous head (e2, balance 60).
  - `afterEvent` (event written, no snapshot): trailing event ignored, recovers to e2.
  - `afterSnapshot` (snapshot written, head not moved): recovers to e2, 1 event ignored.
  - Clean recovery reproduces the exact live state; duplicate events are
    idempotent by id; mid-journal garbage, conflicting duplicate ids and
    dangling heads -> CORRUPT_JOURNAL; torn final line tolerated as crashed
    tail write; recovery deterministic across all three fault points.

## CLI (real runs)

`node cli.js replay /tmp/cli-demo.jsonl --repair` (journal where e3=debit 200
failed with NEGATIVE and e4 therefore also failed; both have no head record):

```json
{
  "head": "e2",
  "accounts": { "a": { "state": "OPEN", "balance": 70, "held": 0 } },
  "repairs": [],
  "ignoredEvents": 2,
  "undoPlan": [ { "op": "credit", "account": "a", "amount": 30, "undoes": "e2" } ]
}
```

Corrupt journal (`garbage` on line 2): prints
`{"error":{"code":"CORRUPT_JOURNAL","message":"unparseable journal line 2"}}`
on stderr, exit code 1.

`--repair` is also covered in `test/cli.test.js`: a journal containing a failed
debit followed by a successful debit on the same account replays with
`repairs: ["e2"]` and final balance 90.
