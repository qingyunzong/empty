# batch-allocator

Offline inventory batch allocation library and CLI. Node.js 22 standard library
only; tests use `node:test`.

## Model

- **Batch**: `{ id, material, quantity, expiry, quality, location }`
  (`quality: "ok" | "quarantined"`, `expiry` ISO date).
- **Order**: `{ id, material, quantity, location, transferCostPerUnit, date }`.

An order is fulfilled by integer quantities from batches that share the
material, are not quarantined, are not expired at the order date (expiry on the
order date is eligible), and are either co-located with the order or moved at
`transferCostPerUnit` per unit.

## Solver (`src/solver.js`)

Finite-domain search: each candidate batch owns an integer variable with domain
`[0, min(available, demand)]`. Bounds propagation (suffix sums of upper bounds)
prunes infeasible nodes; quality status and expiry are unary domain
restrictions. Backtracking branch & bound minimizes total transfer cost, then
minimizes the maximum remaining shelf life of used batches (FEFO). A node
`budget` caps the search: exhaustion reports `unknown`; proven impossibility
reports `infeasible` with per-batch conflict reasons.

## Transaction (`src/allocate.js`)

`allocateOrder(state, order)` is pure: on `infeasible`/`unknown` the input
state is returned untouched, so no partial reservation can leak. On success it
returns a new state with decremented batches and the recorded allocation.

## Persistence (`src/store.js`)

`commitState` writes `state.json.tmp-*`, fsyncs, then atomically renames over
`state.json`. Any failure before the rename (including the injected
`--fail-before-rename`) removes the temp file, leaves the original file
byte-identical, and throws `CommitError`; the CLI exits 3 and the in-memory
allocation is discarded, so a retry produces the complete result.

## CLI

```
node bin/cli.js init --state state.json
node bin/cli.js allocate --state state.json \
  (--order '<json>' | --order-file order.json) \
  [--budget N] [--fail-before-rename]
```

Exit codes: `0` allocated, `1` usage/IO error, `2` infeasible (conflicts on
stdout), `3` commit failed (state preserved, retry safe), `4` unknown (budget
exhausted).

## Tests

```
npm test   # node --test
```

Acceptance coverage:
1. `test/solver.test.js` — small-inventory enumeration: solver cost and max
   remaining expiry match brute-force enumeration of all batch/quantity
   combinations (fixed case + 50 randomized instances).
2. `test/solver.test.js` — expiry boundary: all-expired inventory is
   infeasible with conflicts; a batch expiring exactly on the order date is
   eligible; failed orders leave state untouched.
3. `test/cli.test.js` — injected write failure: exit 3, `state.json` SHA-256
   unchanged, no temp files, retry exits 0 with the complete committed result;
   plus budget-exhaustion (`unknown`, exit 4) and infeasible (exit 2) paths.
