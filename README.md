# inspection-planner

Offline inspection planning library and CLI, built on the Node.js 22 standard
library only (`node:test` for tests). No dependencies.

## Model

Each inspection task has a time window, a zone, required skills, and an
integer duration. Each inspector owns a skill set. Travel between zones costs
a given non-negative integer time (symmetric). The solver assigns every task
an inspector and an integer start time so that:

- the start time lies inside the task's time window,
- the inspector covers all required skills,
- no inspector runs two tasks that overlap (including travel time),

and lexicographically minimizes first the makespan (latest finish time), then
the total travel time.

## Solving approach

Finite-domain CSP: per task there is a person variable (domain = qualified
inspectors) and a start variable (domain = integer starts inside the window).
Propagation prunes by skill sets, time windows, and disjunctive sequencing of
task pairs fixed to the same inspector. Backtracking search (MRV, persons
before starts, earliest start first) enumerates orderings with
branch-and-bound on `(makespan, totalTravel)`.

Outcomes:

- `optimal` — proven optimum, full assignment returned.
- `infeasible` — a conflict proof is returned, naming the tasks, inspectors,
  and/or time windows involved (`skill` / `window` / `sequence`).
- `unknown` — the branch budget was exhausted; `pending` lists the tasks that
  still have no singleton assignment.

## Input format

```json
{
  "inspectors": [{ "id": "amy", "skills": ["electrical"] }],
  "tasks": [
    { "id": "t1", "skills": ["electrical"], "duration": 2,
      "window": { "start": 0, "end": 6 }, "zone": "Z1" }
  ],
  "travel": { "Z1": { "Z2": 1 } }
}
```

`travel` is optional and symmetric; missing pairs default to 0.

## CLI

```
plan input.json --budget 500
```

Prints the result JSON to stdout. Exit codes:

| code | meaning                                    |
| ---- | ------------------------------------------ |
| 0    | optimal plan found                         |
| 1    | infeasible (conflict proof in output)      |
| 2    | invalid input (missing skills, negative travel time, illegal window, ...) |
| 3    | unknown (branch budget exhausted)          |

## Library

```js
const { solve } = require('./src/solver');
const result = solve(model, { budget: 500 });
```

## Tests

```
node --test
```

Acceptance coverage:

1. `test/solver.test.js` cross-checks a 3-inspector / 4-task instance against
   an exact brute force over all person assignments and task permutations.
2. A task requiring a skill nobody has returns an infeasible `skill` conflict.
3. Around the branch-budget threshold the same instance returns `unknown`
   (with pending tasks) below the threshold and `optimal` at/above it.
