# offline-scheduler

Offline parallel-machine scheduling library and CLI (Node.js 22, standard
library only, tests via `node:test`).

Each job has a release time, a deadline, a processing duration, an optional
set of eligible machines and an optional tooling family. Adjacent jobs on the
same machine require a setup time when their families differ, and jobs on one
machine may never overlap. The solver minimizes lexicographically:
1. the makespan (maximum completion time), then 2. the total setup time.

## Solver

`src/solver.js` implements a finite-domain constraint solver:

- **Finite domains**: per job, a machine domain (set of machine indices) and
  an integer start-time domain `[lo, hi]`.
- **Bound propagation**: start domains are clipped by release, deadline and
  the current makespan bound.
- **Non-overlap propagation**: pairwise disjunctive reasoning (including
  family setup times) between jobs fixed to the same machine, plus a
  family-count lower bound for the total-setup bound.
- **Backtracking search**: depth-first assignment of machine and start-time
  variables; the budget is counted in branch points.
- **Optimization**: iterative tightening — first on the makespan, then on the
  total setup under the optimal makespan bound.

Results:

- `optimal` — per-machine verifiable schedule (`schedule` lists, per machine,
  each job with `start`/`end`/`family`).
- `infeasible` — a minimal conflict constraint set (`conflict.jobs`,
  `conflict.machineConstraints`, human-readable `conflict.constraints`)
  computed by deletion-based minimization.
- `unknown` — only when the branch budget is exhausted; reports the
  undecided variables (`pendingVariables`) and never claims unsat.

## CLI

```
node src/cli.js schedule input.json --budget 1000
```

Input errors (missing file/fields, non-integer times, references to
undefined machines, ...) exit with code 2 and a message on stderr.

### Input format

```json
{
  "machines": ["M1", "M2"],
  "setupTime": 2,
  "jobs": [
    { "id": "A", "release": 0, "duration": 3, "deadline": 12,
      "machines": ["M1"], "family": "x" }
  ]
}
```

`machines` entries may be id strings or `{ "id": "M1" }` objects.
`setupTime` defaults to 0, `machines` on a job defaults to all machines,
`family` defaults to `"default"`.

## Tests

```
node --test
```

Acceptance coverage:

1. Small feasible instances are checked against a brute-force enumeration of
   all machine assignments and per-machine permutations.
2. A deadline-conflict instance returns a minimal conflict proof naming the
   concrete jobs and the machine non-overlap constraint.
3. A tiny budget yields `unknown` with pending variables; a larger budget
   solves the same instance to optimality.
