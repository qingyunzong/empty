# budget-reserve

Offline library + CLI that allocates reimbursement reservations to budget
packages. Node.js 22, standard library only, tests with `node:test`.

## Usage

```
node . reserve input.json output.json
```

Exit code is `0` for any solver outcome (`OK` / `PENDING` / `UNSAT`) and `1`
for invalid input (negative amounts, cancellations of unknown documents, ...)
or I/O failures.

## Input format

```json
{
  "packages": [
    { "id": "P1", "limits": { "travel": 1000, "meals": 500 } }
  ],
  "reimbursements": [
    {
      "id": "R1",
      "category": "travel",
      "amount": 800,
      "paid": 0,
      "group": "G1",
      "tiers": ["full", "eighty", "deferred"]
    }
  ],
  "cancellations": [
    { "id": "C1", "target": "R2", "package": "P1" }
  ],
  "backtrackBudget": 10000
}
```

- `packages[].limits` — per-category reservation cap for the package. A
  category not listed has capacity 0 in that package.
- `reimbursements[]`:
  - `amount` — claimed amount (must be >= 0).
  - `paid` — already-paid part (optional, default 0, must be <= `amount`).
  - `group` — optional relation key; all documents sharing a group **must**
    be reserved in the same package.
  - `tiers` — optional allowed tiers, subset of `full` (100%), `eighty`
    (80%), `deferred` (0%). Defaults to all three.
- `cancellations[]` — `target` must reference a known reimbursement. The
  unpaid part of the reservation is released; the paid part becomes
  red-flush pending. If `package` is given, the paid part keeps occupying
  that package's category capacity until the red flush is resolved.
- `backtrackBudget` — optional maximum number of backtracks (default
  100000). Exhaustion yields `PENDING`.

## Output format

```json
{
  "status": "OK",
  "assignments": [{ "id": "R1", "package": "P1", "tier": "full", "reserved": 800 }],
  "packageUsage": [
    { "id": "P1", "categories": { "travel": { "reserved": 800, "redFlushPending": 0, "limit": 1000 } } }
  ],
  "releases": [{ "cancellation": "C1", "target": "R2", "released": 500 }],
  "redFlushPending": [{ "cancellation": "C1", "target": "R2", "amount": 100 }],
  "conflicts": [],
  "stats": { "backtracks": 3, "backtrackBudget": 10000 }
}
```

## Status semantics

- `OK` — the search completed; the assignment maximizes the total reserved
  amount over all feasible tier/package combinations.
- `UNSAT` — the search space was fully explored; no feasible assignment
  exists. `conflicts` explains why (capacity violations and, when
  applicable, categories whose minimum demand exceeds total capacity).
- `PENDING` — the backtrack budget was exhausted before the search
  finished; optimality/feasibility is undecided. If a feasible incumbent
  was found before the budget ran out, it is returned in `assignments`.

## Solver

Finite-domain CSP: one package variable per related-document group, one
tier variable per document. Propagation prunes packages whose remaining
per-category capacity cannot hold a group's minimum demand and tiers that
would exceed the remaining capacity. Branch-and-bound search prefers higher
tiers and earlier packages and keeps the incumbent with the highest total
reserved amount; every undo consumes the backtrack budget.

## Tests

```
node --test
```
