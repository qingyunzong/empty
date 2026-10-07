# budget-reserve

Offline library and CLI for allocating expense reservations to budget
envelopes. Node.js 22, standard library only, tests via `node:test`.

## Usage

```
node . reserve input.json output.json
```

Exit codes:

- `0` — the solver ran; see `status` in the output file.
- `1` — invalid input (negative amounts/limits, paid > amount, duplicate ids,
  cancellation of an unknown expense, unreadable file, bad usage).

## Input

```json
{
  "envelopes": [{ "id": "E1", "category": "travel", "limit": 200 }],
  "expenses": [{ "id": "R1", "category": "travel", "amount": 120, "paid": 0, "group": "G1" }],
  "cancellations": [{ "expenseId": "R2" }],
  "backtrackBudget": 10000
}
```

- `envelopes[]`: budget envelopes, each with a per-category `limit`.
- `expenses[]`: expense orders. `paid` (already-paid part, default 0) must be
  covered by the envelope under every tier. `group` is optional; expenses
  sharing a group must be placed in the same envelope.
- `cancellations[]`: cancels an expense. Only the unpaid part is released;
  the paid part becomes red-flush pending.
- `backtrackBudget`: maximum number of backtracks before the search gives up
  (default 10000).

## Tiers

Each active expense is assigned one tier; the reserved occupancy is
`max(paid, ratio * amount)`:

| tier       | ratio |
|------------|-------|
| `FULL`     | 1.0   |
| `EIGHTY`   | 0.8   |
| `DEFERRED` | 0     |

## Output

```json
{
  "status": "OK | UNSAT | PENDING",
  "assignments": [{ "expenseId": "R1", "envelopeId": "E1", "tier": "FULL", "reserved": 120 }],
  "envelopes": [{ "id": "E1", "category": "travel", "limit": 200, "used": 180, "remaining": 20 }],
  "cancellations": [{ "expenseId": "R2", "released": 40, "redFlushPending": 10 }],
  "totals": { "released": 40, "redFlushPending": 10, "reserved": 260 },
  "conflicts": [{ "expenseId": "R3", "reason": "...", "envelopes": [], "blockers": [] }],
  "stats": { "nodes": 3, "backtracks": 0, "backtrackBudget": 10000 }
}
```

Status semantics:

- `OK` — a feasible assignment was found.
- `UNSAT` — the search space was exhausted within the backtrack budget; no
  feasible assignment exists.
- `PENDING` — the backtrack budget was exhausted before the search finished;
  feasibility is undecided.

## Solver

Finite-domain CSP over (envelope, tier) pairs per expense with constraint
propagation (category match, group co-location, per-envelope capacity),
MRV variable ordering, tier-major value ordering (FULL first), depth-first
backtracking bounded by the backtrack budget, and conflict recording: when a
domain wipes out, the conflicting expense, candidate envelopes and blocking
assignments are reported in `conflicts`.

## Tests

```
node --test
```

Covers the four acceptance scenarios (related expenses co-located,
cancellation freeing capacity, over-limit UNSAT, small-budget PENDING),
input validation, CLI exit codes, and a brute-force cross-check that
enumerates every (envelope, tier) combination for up to 3 envelopes and 3
expenses and compares against the solver.
