# RESULTS

Recorded from real runs in this workspace (Node v22.22.1, linux x64).

## Full test suite

Command: `node --test` (run 2026-10-02T21:07:34Z UTC)

```
# tests 4        # test files: brute, cli, solver, store
# pass 4
# fail 0
# duration_ms 2674.87019
```

Per-file breakdown (each file run individually, TAP summary):

| file                | tests | pass | fail |
| ------------------- | ----- | ---- | ---- |
| test/brute.test.js  | 10    | 10   | 0    |
| test/cli.test.js    | 9     | 9    | 0    |
| test/solver.test.js | 14    | 14   | 0    |
| test/store.test.js  | 9     | 9    | 0    |
| **total**           | **42**| **42**| **0**|

## Acceptance criteria coverage

1. **unlock triggers re-scheduling, equivalent to a fresh recompute** —
   `store.test.js` ("unlock triggers a full recompute equivalent to a fresh
   instance") and `cli.test.js` ("lock then unlock recomputes equivalently to
   the unlocked instance"): after `unlock_slot`, the incumbent is invalidated
   and the next `optimize` result deep-equals a fresh instance's result.
2. **Nested snapshot restore** — `store.test.js` ("nested snapshots restore
   in stack order and future snapshots lapse", "snapshots capture locks and
   results too") and `cli.test.js` ("snapshot/restore round-trip across
   invocations"): LIFO restore, future snapshots lapse, empty stack errors.
3. **Hazardous-exclusion UNSAT yields the minimal recipe set** —
   `solver.test.js` ("UNSAT on forced hazardous coexistence returns the
   minimal recipe core", core = `['R1','R2']` with a compatible third recipe
   dropped) and `cli.test.js` ("UNSAT -> exit 2 with minimal hazardous core").
4. **Brute-force cross-check for n <= 9** — `brute.test.js`: randomized
   instances (seeded, reproducible) for n = 1..9 plus locked instances;
   solver and exhaustive enumerator agree on status, objective, and the
   scheduled recipe-ID set.

## Exit-code verification (process level, via shell)

`bin/furnace.js` sets `process.exitCode = main(argv)`. Verified by invoking
the CLI from bash (nested node spawns are blocked inside this sandbox, so
the automated tests assert `main()`'s return codes in-process instead):

| scenario                              | exit |
| ------------------------------------- | ---- |
| `optimize` feasible instance          | 0    |
| `optimize` hazardous-exclusion UNSAT  | 2    |
| `optimize --budget-backtrack 0`       | 3    |
| unknown command                       | 4    |
| `restore` with empty snapshot stack   | 4    |

UNSAT process output includes the minimal core:

```json
{ "status": "UNSAT", "core": ["R1", "R2"], ... }
```
