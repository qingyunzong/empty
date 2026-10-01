# Nested Action Executor

Executes a tree of nested actions against a global budget `B` (`0 <= B <= 1000`),
with saga-style compensation on failure.

## Plan format

```json
{
  "budget": 100,
  "root": {
    "id": "root",
    "cost": 10,
    "compensation_cost": 5,
    "outcome": "success",
    "children": [ ]
  }
}
```

* `id` — unique, non-empty string (required).
* `cost` — non-negative integer, deducted from the budget when the action starts.
* `compensation_cost` — non-negative integer, deducted when the action is compensated.
* `outcome` — `success` (default), `fail`, or `unsat`.
* `children` — list of child actions, executed in declared order.

## Execution semantics

1. **Outcomes.** An action succeeds, fails, or is `unsat`. `unsat` means the
   precondition can never hold: the action fails immediately, costs nothing,
   runs no children, and is never retried as pending. `fail` consumes the
   action cost (the attempt happened) but applies no effect and runs no
   children.
2. **Order and rollback.** Children run in declared order. The first failing
   child aborts its later siblings (they are never started and never
   compensated) and triggers compensation of everything already completed,
   deepest first: for each completed sibling subtree in recovery order,
   compensate its descendants then itself, then compensate the parent.
3. **Budget.** Compensation also consumes budget. If the budget cannot pay
   for the next compensation, the run ends in `BUDGET_EXHAUSTED` and the
   recorded compensation sequence is exactly the provably compensated prefix.
   If the budget cannot cover the *cost* of the next action during forward
   execution, that action fails (a `budget_shortfall` event is recorded) and
   normal rollback proceeds with the remaining budget.
4. **Tie-breaking.** The recovery order of completed siblings is reverse
   completion order. Siblings whose cost AND compensation cost are exactly
   equal form a tie class: the class keeps the position of its
   last-completed member, and its members are compensated in ascending
   action-id order. Ties are only permitted when both costs are equal.
5. **Final states.** Exactly one of `COMMITTED` (root succeeded),
   `ROLLED_BACK` (a failure occurred and all required compensations were
   paid), or `BUDGET_EXHAUSTED` (compensation could not be fully paid).

## CLI

```
python -m executor [--state PATH] load <plan.json>
python -m executor [--state PATH] run
python -m executor [--state PATH] status
```

State is persisted in `.executor_state.json` (override with `--state` or the
`EXECUTOR_STATE` environment variable). Any error (bad arguments, invalid
plan, missing state, I/O failure) prints to stderr and exits with code **7**.

## Tests

```
python -m unittest discover -s tests -v
```

Acceptance coverage:

* **A** — `AcceptanceAReferenceComparison`: 300 random trees (<= 30 nodes)
  compared against an independent recursive reference enumeration
  (`executor/reference.py`) for final state, compensation sequence, remaining
  budget, and execution order.
* **B** — `AcceptanceBDeepFailure`: deep failures never compensate
  unexecuted siblings.
* **C** — `AcceptanceCBudgetExhaustion`: budget exhausted exactly during
  compensation returns the deterministic compensated prefix.
* **D** — `AcceptanceDTieBreak`: tied recovery strategies broken by action id.
