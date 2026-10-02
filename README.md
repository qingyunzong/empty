# cost-allocation

Offline shared-cost allocation library and CLI. Node.js 22, standard library
only, tests via `node:test`.

## Usage

```
node . allocate input.json output.json
```

Exit codes: `0` success (any allocation status), `1` invalid input (ratio set
does not sum to 100, cancelling an unknown or already-cancelled document),
`2` usage/IO errors.

## Input

```json
{
  "totalAmount": 10000,
  "tiers": [0, 10, 20, 100],
  "searchBudget": 100000,
  "centers": [{ "id": "A", "minRatio": 20, "maxRatio": 80, "cap": 9000 }],
  "ratios": { "A": 40 },
  "adjustments": [{ "id": "ADJ-1", "center": "A", "ratio": 50 }],
  "cancellations": ["ADJ-1"]
}
```

- `tiers`: allowed ratio (percent) levels per center.
- `cap`: audit cap on the allocated amount of a center.
- `ratios` (optional): proposed ratio set; must sum to 100 (exit 1 otherwise).
- `adjustments`: lock a center to a new ratio; only unlocked centers can be
  adjusted (attempts on locked centers are rejected and traced).
- `cancellations`: remove an adjustment layer and restore the occupancy that
  existed before it, then recompute incrementally.

## Solving

Domains are filtered by bounds and caps, illegal ratios are deleted by
constraint propagation (sum-to-100 reachability), then a backtracking search
runs over centers ordered by domain size. Results:

- `OK`: ratios sum to 100, every amount within its cap.
- `UNSAT`: no feasible allocation; `conflictCenters` holds a minimal set of
  centers whose constraints conflict even if all others were free.
- `PENDING`: the search-node budget was exhausted (never reported as UNSAT).

Adjustments and cancellations trigger incremental recompute: locked centers
stay fixed and only the unlocked part is re-searched, preferring the previous
occupancy.

## Output

`status`, per-center `allocation` (`ratio`, `amount`, `locked`), `totalRatio`,
`allocatedAmount`, `lockedAmount`, `pendingAmount`, `conflictCenters`,
`searchNodes`, and the full recompute `trace`.

## Tests

```
node --test
```

Covers the four acceptance scenarios (3-center feasible, incremental
re-selection after adjustment, cap-exclusion UNSAT, budget PENDING) plus a
brute-force enumeration cross-check for <=3 centers.
