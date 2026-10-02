# shared-expense-allocator

Offline library + CLI (Node.js 22, standard library only) that allocates a
shared expense across cost centers. Each center picks a ratio tier, ratios
must sum to 100%, and every center's amount must stay within its audit
bounds. Adjustments and cancellations are recomputed incrementally.

## Usage

```
node . allocate input.json output.json
npm test
```

## Input (`input.json`)

```json
{
  "totalAmount": 10000,
  "searchBudget": 100000,
  "costCenters": [
    { "id": "A", "tiers": [20, 30, 40, 50], "minAmount": 0, "maxAmount": 5000 }
  ],
  "adjustments": [
    { "id": "ADJ-1", "set": { "A": 30 } },
    { "id": "ADJ-2", "ratios": { "A": 40, "B": 40, "C": 20 } }
  ],
  "cancellations": [
    { "target": "ADJ-1" }
  ]
}
```

- `tiers`: allowed ratio (percent) tiers per center.
- `minAmount` / `maxAmount`: audit bounds on the allocated amount
  (optional; defaults `0` / unbounded). Illegal tiers are deleted by
  propagation before search.
- `adjustments[].set`: pins centers to tiers and locks them; only the
  unlocked remainder is re-solved (incremental recompute).
- `adjustments[].ratios`: explicit full assignment; must cover all centers
  and sum to 100.
- `cancellations[].target`: cancels an applied adjustment layer and
  restores the occupancy captured before that layer; later layers are
  dropped.
- `searchBudget`: max backtracking nodes (default 1,000,000). Exhaustion
  yields `PENDING`, never `UNSAT`.

## Output (`output.json`)

- `status`: `FEASIBLE` | `UNSAT` | `PENDING`.
- `allocation`: per-center `ratio`, `amount`, `locked`.
- `lockedAmount` / `pendingAmount`: locked vs. still-undecided amounts.
- `conflictCenters`: minimal conflicting center set when `UNSAT`.
- `trace`: recompute trajectory (propagation, solves, adjustments,
  cancellations).

## Exit codes

- `0`: run completed (any status).
- `1`: explicit ratios do not sum to 100, or cancelling an
  already-cancelled / unknown document.
- `2`: bad usage or unreadable input.
