# RESULTS

Baseline: Node.js v22.22.1, standard library only, `node:test`, single machine, offline.

## Test run

Command: `node --test`
Date: 2026-10-03 (Asia/Shanghai)
Exit code: 0

```
# tests 7
# pass 7
# fail 0
# duration_ms 101359.463638
```

| File | Result | Covers |
| --- | --- | --- |
| test/a-basic.test.js | ok | A: debit/credit/hold/release, commit/void, idempotent duplicate ids |
| test/b-error-repair.test.js | ok | B: NEGATIVE -> ERROR, repair restores prior state, HOLD_LEAK |
| test/c-batch-undo.test.js | ok | C: 3-layer batch, layer-2 local rollback, abort policy, determinism |
| test/d-enumeration.test.js | ok | D: exhaustive enumeration vs independent oracle |
| test/e-recovery.test.js | ok | E: 3 fault points, idempotent replay, CORRUPT_JOURNAL |
| test/f-fork.test.js | ok | FORK_CONFLICT witness paths, undo target validation |
| test/g-cli.test.js | ok | CLI `replay` with/without `--repair` |

## Acceptance evidence

- A: open 100, debit 40, credit 10, hold 25, release 15 -> balance 70, frozen 10; duplicate event id applied once.
- B: debit 80 on balance 50 -> `NEGATIVE`, account enters ERROR, balance unchanged; non-repair events rejected with `ILLEGAL_TRANSITION`; `repair` restores the pre-error status (INIT/ACTIVE/COMMITTED) and operations resume.
- C: history open 10 / credit 100 / debit 105 / debit 2 (balance 3); 3-layer undo plan with `onChildFailure: 'continue'`: layer 3 (+2) executes, layer 2 (-100) fails `NEGATIVE` and rolls back layer 3 locally, layer 1 continues and undoes the debit 105 -> final balance 108, only `e3` marked undone. With `'abort'` the whole batch rolls back to 3. Two identical runs produce deep-equal results (deterministic).
- D: BFS enumeration of all event sequences up to 12 events over 3 accounts (probe alphabet includes legal moves plus deliberate illegal ones to cover error/repair loops): 281,975 states enumerated, 2,199,837 transitions checked, library `transition` matched the independent oracle on every state and error code.
- E: journal write protocol event -> snapshot -> head. Crash before event write, after event write (no snapshot), and after snapshot (no head update) all recover to the last consistent head (seq 4, identical state); a clean re-append recovers to seq 5; duplicate event ids replay once; mid-file corruption raises `CORRUPT_JOURNAL`, a torn tail line is truncated.

## CLI

`node cli.js replay journal.jsonl --repair` prints JSON with `accounts` (status/balance/frozen), `errors` (with codes), and `undoPlans`. Verified manually:

```
$ node cli.js replay /tmp/fixture.jsonl --repair
accounts.a = { status: ACTIVE, balance: 60, frozen: 0 }
errors = [{ eventId: e2, code: NEGATIVE }]
```

## Notes

- Error codes: `ILLEGAL_TRANSITION`, `NEGATIVE`, `HOLD_LEAK`, `FORK_CONFLICT`, `CORRUPT_JOURNAL`.
- Lifecycle DFA is explicit in `src/core.js` (INIT/ACTIVE/COMMITTED/VOID/ERROR; ERROR accepts only `repair`).
- Undoability is decided by parent pointers: the target must be an ancestor of the account head, otherwise `FORK_CONFLICT` is returned with a witness `{ forkPoint, headPath, branchPath }` and no state changes.
