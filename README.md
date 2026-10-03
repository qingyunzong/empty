# offline-scheduler

Offline parallel-machine scheduling with tooling families, implemented with the
Node.js 22 standard library only (solver, CLI, and `node:test` tests).

## Model

Each job has a release time, deadline, integer duration, an optional list of
eligible machines, and a tooling family. Two adjacent jobs on the same machine
with different families require `setupTime` changeover between them; jobs on one
machine may never overlap. The objective is lexicographic: minimize the makespan
first, then the total changeover time.

## Input format

```json
{
  "machines": ["M1", "M2"],
  "setupTime": 2,
  "jobs": [
    { "id": "A", "release": 0, "deadline": 12, "duration": 3,
      "machines": ["M1", "M2"], "family": "F1" }
  ]
}
```

`setupTime`, `machines` (per job, defaults to all machines) and `family`
(default `"default"`) are optional. All times must be integers.

## CLI

```
node src/cli.js schedule input.json --budget 1000
```

- `optimal` / `feasible`: prints a per-machine schedule (verifiable with
  `verifySchedule` in `src/verify.js`); `feasible` means the budget ran out
  before optimality was proven.
- `unsat`: prints a deletion-minimal conflict (jobs + machine constraints).
- `unknown`: budget exhausted; prints the pending variables. Never claims
  `unsat` when the budget is exhausted.
- Exit code `2`: missing input, non-integer times, undefined machines, or
  usage errors.

## Solver

`src/solver.js` is a CSP solver: finite machine domains and integer start-time
bound domains per job, bound propagation, non-overlap (disjunctive) propagation
with family changeovers, and backtracking search. The budget counts branches.

## Tests

```
node --test
```

Tests compare the solver against exhaustive enumeration of machine assignments
and per-machine permutations, check conflict proofs, budget behaviour, and CLI
exit codes. Real test/CLI output and exit codes are recorded in `result.txt`.
