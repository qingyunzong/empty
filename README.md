# furnace-scheduler

Sintering campaign scheduler for a materials-discovery platform: packs
finite-domain recipes into a limited number of furnace runs (炉次) and proves
the schedule feasible, optimal, infeasible (with a minimal recipe core), or
reports the best bound within budget.

Node.js 22, standard library only, tests with `node:test`.

## Model

Each recipe is a finite-domain variable:

- `temps` — allowed temperature tiers (positive integers)
- `atmos` — allowed atmospheres (strings)
- `durs` — allowed duration tiers (positive integers)
- `crucible` — required crucible type
- `priority` — objective weight (>= 0)

Resources and hard constraints (per `init` config):

- `slots` — furnace positions per run (batch capacity)
- `crucibles` — per-type crucible count available to each run
- `gasBudget` / `gasUsage` — total gas per day; each atmosphere consumes
  `gasUsage[atmo]` per scheduled recipe
- `maxRunsPerDay` — daily batch cap; batches are indexed `0 .. days*maxRunsPerDay-1`
- ramp compatibility — recipes sharing a run must have equal ramp class
  `ceil(temp / dur)`
- `maxTempDiff` — max temperature-tier difference inside one run
- `hazards` — atmosphere groups whose distinct members are mutually exclusive
  inside one run (e.g. `h2:o2`)
- `requiredPriority` — recipes with `priority >= requiredPriority` (and all
  locked recipes) must be scheduled; infeasibility of that set is UNSAT

Objective: satisfy all hard constraints, then maximize the sum of priorities
of scheduled recipes. Ties are broken by the lexicographically smaller sorted
list of scheduled recipe IDs (shorter list wins a prefix).

## Solver

- Propagation of resource-profile lower bounds: forward-checking plus, for
  every required recipe confined to a single day, a check that the summed
  minimum gas and the recipe count still fit that day's remaining budget and
  free slots.
- Backtracking assigns (batch, value) pairs; optional recipes may be skipped.
  Branch-and-bound prunes on the remaining priority sum; equal-weight ties
  are still explored to honor the recipe-ID tie-break.
- Budgets come in three kinds: `propagate`, `backtrack`, `improve`
  (objective improvements). Exhausting any of them returns `PENDING` with the
  incumbent and the current best bound — never `UNSAT`.
- On `UNSAT` the solver returns a deletion-minimal core: a minimal set of
  required recipes that is already infeasible.

## CLI

State lives in a JSON file (default `.furnace-state.json`, override with
`--state`). Snapshot/restore is a stack: `restore` pops the latest snapshot
and every "future" snapshot above it lapses. `lock_slot` is only accepted for
variables not scheduled by the incumbent result; `unlock_slot` invalidates
the incumbent so the next `optimize` recomputes from scratch.

```
furnace init --days 2 --max-runs-per-day 2 --slots 3 --gas-budget 10 \
  --max-temp-diff 1 --crucibles alumina:2,graphite:1 \
  --gas-usage air:0,n2:2,h2:5,o2:3 --hazards h2:o2 [--required-priority 8]
furnace add_recipe --id R1 --priority 5 --temps 1,2 --atmos n2,h2 --durs 1 \
  --crucible alumina
furnace lock_slot --recipe R1 --batch 0 --temp 1 --atmo n2 --dur 1
furnace unlock_slot --recipe R1
furnace snapshot
furnace restore
furnace optimize [--budget-propagate N] [--budget-backtrack N] [--budget-improve N]
```

Exit codes:

| code | meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | ok / `OPTIMAL`                                   |
| 2    | `UNSAT` (minimal recipe core in the JSON output) |
| 3    | `PENDING` (a budget ran out; best bound reported)|
| 4    | usage / input error                              |

## Library

- `src/model.js` — shared semantics (feasibility primitives, tie-break)
- `src/solver.js` — `solve(problem, budgets)`, propagation + backtracking
- `src/brute.js` — exhaustive enumerator used to cross-check the solver
- `src/store.js` — `Store`: recipes, locks, snapshot stack, optimize caching
- `src/cli.js` — `main(argv)` argument parsing and exit-code mapping

## Tests

```
node --test
```

Covers: constraint semantics, tie-break, UNSAT minimal core, PENDING on each
budget kind, nested snapshot/restore, unlock-triggers-recompute equivalence,
lock validation, CLI exit codes, and a brute-force cross-check of the solver
on randomized instances with n <= 9 recipes.
