# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test`, single machine, offline.

## Test run: `node --test`

Real output (2026-10-07):

```
ok 1 - test/acceptance.test.js
ok 2 - test/cli.test.js
ok 3 - test/enumeration.test.js
ok 4 - test/scale.test.js
# tests 4
# suites 0
# pass 4
# fail 0
# duration_ms 17839.347919
```

All 4 test files pass (34 individual assertions groups; 0 failures).

## Acceptance criteria mapping

- **A — transfer+freeze combo succeeds** (`test/acceptance.test.js`):
  batch `T1` = transfer alice->bob 80 + freeze bob 50 commits atomically;
  state `alice{120,0} bob{80,50}`, budget 920; undo restores all inverses in
  event-time-descending order (`unfreeze` then `transfer`).
- **B — insufficient balance rolls back the whole batch**: `withdraw 999`
  inside a batch fails with `INSUFFICIENT`; earlier ops in the same batch are
  reverted (no partial effect), remaining ops are `skipped`, `batchEnd` reports
  the failure, and the batch leaves no undoable unit.
- **C — failed inner batch does not affect committed outer batch**: nested
  `batchBegin` is rejected with `BATCH_NESTING`; the inner batch then fails and
  rolls back completely while the already-committed outer batch stays intact
  and remains undoable.
- **D — exhaustive enumeration cross-check** (`test/enumeration.test.js`):
  all 66,429 sequences of length <= 5 over 9 op templates x 2 accounts, plus
  4,000 seeded random sequences of length 6..10 including batches and
  cross-batch undo. Checked per step: invariants (balance>=0, frozen>=0,
  frozen<=balance, day budget>=0), successful undo restores the exact state
  captured before the undone unit, and replay is deterministic.
- **E — AMBIGUOUS_UNDO**: batch of `deposit a 10 @ts=5` + `deposit b 10 @ts=5`
  yields two tied plans (same length 2, same accounts {a,b}, same event times);
  `undo` fails with `AMBIGUOUS_UNDO` and `error.details.plans` lists both
  plans; state is left untouched.

## Scale

`test/scale.test.js`: 50,000 mixed operations (deposits, withdrawals,
transfers, batches, undos) over 100 accounts with a day budget — completed in
~13-15s with invariants asserted after every step (45,000 ok / 5,000 expected
structural errors such as `batchEnd` without an open batch).

## CLI verification

`node cli.js exec examples/demo.jsonl --budget day=1000` exits 0 and prints 11
JSONL steps covering: commit of transfer+freeze batch `T1`, `INSUFFICIENT`
batch rollback of `T2`, top-of-stack undo, cross-batch `undo --batch T1`
expanded to a deterministic inverse sequence, and `UNDO_GAP` when the chain is
empty. `node cli.js exec examples/ambiguous.jsonl` reproduces criterion E
through the CLI (error `AMBIGUOUS_UNDO` with both tied plans listed).
