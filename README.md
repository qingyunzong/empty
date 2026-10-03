# genealogy-trace

Quality traceability library and CLI built on the Node.js 22 standard library
(tests use `node:test`; no dependencies).

Production batches draw integer input quantities from candidate parent lots
(raw materials or earlier batches), forming a traceable genealogy. The solver
represents candidate parents and input quantities as finite integer domains,
propagates quality status, expiry and quantity bounds to a fixpoint, then
backtracks to a feasible genealogy.

## Constraints

- **mass-balance**: inputs of a batch sum to `output + loss` (fixed loss).
- **quarantine-closure**: a quarantined lot may not be used directly or
  indirectly; a batch that cannot meet its required input from clean parents
  is itself blocked and the blockage propagates downstream.
- **expiry-order**: a batch's expiry must not be later than the expiry of any
  lot it consumes.
- **line-no-overlap**: batches on the same production line must not overlap
  in time.
- **supply-limit**: no lot is consumed beyond its available quantity.

## Input format

```json
{
  "materials": [{ "id": "M1", "quantity": 8, "expiry": "2026-12-01", "status": "released" }],
  "batches": [{
    "id": "P1", "line": "L1",
    "start": "2026-01-01T00:00:00Z", "end": "2026-01-01T04:00:00Z",
    "output": 10, "loss": 2, "expiry": "2026-06-01",
    "candidates": ["M1", "M2"]
  }],
  "budget": 100000
}
```

`status` defaults to `released`; `quarantined` lots seed the quarantine
closure. Quantities must be integers (`output > 0`, `loss >= 0`,
`quantity >= 0`). Candidate references must resolve and the genealogy must be
acyclic.

## CLI

```
node src/cli.js trace <input.json> [--state <path>] [--budget <n>]
node src/cli.js undo  [--state <path>]
node src/cli.js redo  [--state <path>]
```

Each `trace` appends one transaction to the state file (default
`trace.state.json`), solves, and prints the result. `undo`/`redo` revert and
re-apply transactions; undo removes the added genealogy edges **and** every
propagation conclusion derived from them (the derived cache is invalidated on
any mutation), then re-solves and prints the restored result.

Exit codes:

| code | meaning |
| ---- | ------- |
| 0 | `feasible` (also `undone`/`redone`/no-op histories) |
| 1 | `infeasible` — conflict proof names the batches/constraints involved |
| 2 | invalid input — illegal quantities, broken references, cycles, bad dates |
| 3 | `unknown` — search budget exhausted, pending choices are listed |

## Library

- `src/model.js` — validation (`ValidationError` for every exit-2 case).
- `src/store.js` — `TraceStore`: transactional `applyTransaction`/`undo`/`redo`
  with JSON persistence; derived conclusions are invalidated on mutation.
- `src/propagate.js` — finite-domain propagation (taint closure, expiry
  filtering, `[lb, ub]` quantity bounds) and conflict-proof construction.
- `src/solve.js` — budget-bounded backtracking over integer quantity splits.
- `src/bruteforce.js` — independent exhaustive enumerator and direct
  assignment checker used to cross-check the solver.

## Tests

```
node --test
```

Recorded real run (this workspace, Node v22.22.1):

```
# tests 7
# pass 7
# fail 0
```

Acceptance coverage:

1. `test/enumerate.test.js` — 60 seeded random small instances: the solver's
   verdict matches exhaustive enumeration of every legal parent subset and
   quantity split, and every feasible assignment passes the independent
   `checkAssignment` verifier.
2. `test/quarantine.test.js` — a quarantined lot failing through three
   production layers yields the complete conflict chain
   `M0 -> P0 -> P1 -> P2`.
3. `test/undoredo.test.js` / `test/cli.test.js` — after undo the store and
   the solve result are identical to the pre-add state (derived conclusions
   are gone); after redo the result is identical to the original.

## Recorded CLI runs (real output, real exit codes)

`trace examples/feasible.json` → exit 0:

```json
{
  "status": "feasible",
  "assignment": { "P1": { "M1": 4, "M2": 8 } },
  "nodes": 1
}
```

`trace examples/quarantine-chain.json` → exit 1 (chain trimmed for
readability; full run prints `needed`/`cleanSupply`/`blockedParents` per
layer):

```json
{
  "status": "infeasible",
  "conflict": {
    "constraints": ["mass-balance", "quarantine-closure"],
    "batches": ["P0", "M0", "P1", "P2"],
    "chain": [
      { "batch": "M0", "rule": "quarantined" },
      { "batch": "P0", "rule": "insufficient-clean-supply", "needed": 10, "cleanSupply": 0, "blockedParents": ["M0"] },
      { "batch": "P1", "rule": "insufficient-clean-supply", "needed": 10, "cleanSupply": 0, "blockedParents": ["P0"] },
      { "batch": "P2", "rule": "insufficient-clean-supply", "needed": 10, "cleanSupply": 0, "blockedParents": ["P1"] }
    ]
  }
}
```

`trace examples/unknown.json --budget 1` → exit 3:

```json
{
  "status": "unknown",
  "reason": "budget-exhausted",
  "nodes": 2,
  "pending": [
    { "batch": "P1", "required": 25, "choices": [
      { "parent": "M1", "lb": 5, "ub": 10 },
      { "parent": "M2", "lb": 5, "ub": 10 },
      { "parent": "M3", "lb": 5, "ub": 10 } ] },
    { "batch": "P2", "required": 6, "choices": [
      { "parent": "M1", "lb": 0, "ub": 6 },
      { "parent": "M2", "lb": 0, "ub": 6 },
      { "parent": "M3", "lb": 0, "ub": 6 } ] }
  ]
}
```

`trace examples/invalid-quantity.json` → exit 2:

```json
{ "status": "invalid", "error": "M1: quantity must be a non-negative integer, got -5" }
```

`trace examples/broken-reference.json` → exit 2:

```json
{ "status": "invalid", "error": "P1: broken reference to unknown candidate parent M404" }
```

Undo/redo session (exit 0 each): after `trace feasible.json` then
`trace second-batch.json`, `undo` prints `{"status": "undone", "depth": 1,
"result": <the exact first trace result>}` and `redo` prints
`{"status": "redone", "depth": 2, "result": <the exact second trace result>}`.
