# thermal-scheduler

Thermal-aware single-machine task scheduling CLI. Pure TypeScript + Node.js
built-in modules only (zero npm dependencies). Finds the shortest makespan
schedule under a temperature ceiling and per-task deadlines, prints the
per-tick heat trajectory, and cross-checks the answer with an independent
exhaustive per-tick state-space search.

## Problem definition

- Up to **14 tasks**, non-preemptive, single machine.
- Each task: `duration` (ticks), `heat` (integer heat units added per running
  tick), `deadline` (completion must be at or before this tick).
- Each tick, exactly one of:
  - run the current task: `temp += heat` (checked against `maxTemp` after
    **every** tick);
  - idle: `temp = max(0, temp - coolingRate)`.
- Horizon: at most **50 ticks** (`maxTicks`, also the upper bound for
  deadlines).
- Goal: minimize the makespan (completion time of the last task), or report
  infeasibility within the horizon.

## Usage

```sh
npm run build          # tsc -> dist/
node dist/src/cli.js examples/sample.json
node dist/src/cli.js examples/sample.json --json
npm test               # tsc + run compiled test suite
```

Input JSON:

```json
{
  "maxTemp": 20, "coolingRate": 2, "initialTemp": 0, "maxTicks": 50,
  "tasks": [{ "id": "t1", "duration": 3, "heat": 4, "deadline": 12 }]
}
```

`initialTemp` defaults to 0, `maxTicks` defaults to 50.

## Design

- `src/solver.ts` — primary solver. Time-ordered search over
  `(completedMask, temp, time)` with Pareto dominance pruning (for a fixed
  mask, cooler+earlier dominates) and a bucket queue over times 0..50, so the
  first popped goal state is optimal.
- `src/verifier.ts` — independent checker. Exhaustive per-tick BFS over the
  raw machine state `(mask, runningTask, remainingTicks, temp, time)` with
  only exact-state dedup and no dominance pruning; a deliberately different
  state representation and transition structure.
- `src/simulate.ts` — replays the returned schedule tick by tick, checking
  ceiling, cooling, durations, deadlines, overlaps, and horizon.
- `src/cli.ts` — wires everything together; exits non-zero if the two
  engines disagree or the trajectory fails validation.

## Recorded actual results

Environment: Node v22.22.1, TypeScript 7.0.2, Linux x86_64.

`npm test` (tsc + compiled suite, 2026-10-05):

```
# tests 211
# suites 6
# pass 211
# fail 0
# duration_ms ~1400
```

The suite includes 200 seeded random instances (1–8 tasks) where the primary
solver and the exhaustive verifier must agree on feasibility and makespan,
plus hand-computed cases (known optimum 6; cooling-forced optimum 7),
infeasible cases, a 14-task instance (makespan 28), and input-validation
cases.

`node dist/src/cli.js examples/sample.json`:

```
optimal makespan: 30 ticks (explored 288 states)
heat trajectory: 1:t2->6 2:t2->12 3:idle->10 ... 30:t3->20
exhaustive per-tick search: makespan=30 (explored 12834 states)
cross-check: AGREE
trajectory validation: OK
```
