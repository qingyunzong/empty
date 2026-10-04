# sched — 4-employee shift scheduler

`sched` assigns up to 16 shifts to exactly 4 employees at minimum cost,
using only the Go standard library.

## Model

- **Shifts** are given in start-time order; every shift must be assigned to
  exactly one employee.
- **Constraints**
  - skill compatibility: a shift's required skill must be in the
    employee's skill set (empty skill = anyone);
  - per-employee total-minutes cap (`Employee.MaxHours`);
  - minimum rest (`Params.MinRest`) between adjacent shifts of the same
    employee.
- **Costs**
  - changeover penalty (`Params.Changeover`) whenever two consecutive
    shifts go to different employees;
  - tiered overtime ladder (`Params.Tiers`): each employee's total minutes
    are billed per minute through increasing rate rungs, the last rung
    unbounded.

## Solver

`(*Instance).Solve` runs A* over the shift sequence. A search node stores,
per employee, the total assigned minutes and last shift end, plus the
previous assignee. The admissible heuristic is the cheapest fractional
placement of the remaining minutes into the remaining tier capacity
(exact for convex, non-decreasing rates); nodes whose remaining minutes
exceed the total remaining caps are pruned as provably infeasible.

## Output

- `Solution`: per-shift assignee, per-employee minutes/labor, changeover
  count and total cost — the minimum-cost table, rendered by
  `(*Instance).Report`.
- `Verify` independently re-checks every constraint and recomputes the
  cost from scratch, returning a per-employee `Certificate`.

## Acceptance

`go test ./...` runs, among others:

- `TestSolveMatchesBruteForce` / `TestSolveMatchesBruteForce12`: the A*
  optimum must equal the minimum over all 4^n explicitly enumerated
  assignments for random instances up to 12 shifts;
- `TestSixteenShifts` / `TestSixteenShiftsStress`: full-size instances are
  solved and their certificates verified.

Latest recorded run (Go 1.27.1, linux/amd64):

```
ok  	sched	3.5s
```
