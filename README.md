# maintenance-scheduler

Optimal maintenance scheduling library and offline CLI. Node.js 22, standard
library only, tests with `node:test`. No dependencies.

## Problem

Repair tasks form a DAG (precedence constraints). Each task has one or more
execution **modes**; a mode fixes `duration` (工时), `cost` (费用) and required
spare `parts` (备件). The site has **2 interchangeable crews** (configurable
1–8) and a fixed total **budget**. A schedule assigns each task exactly one
mode and one non-preemptive interval on one crew, respecting precedence, crew
capacity, the budget (total cost ≤ budget) and spare-parts inventory.

## Objectives (lexicographic, in this order)

1. **Minimize total downtime** (总误工) = sum of task completion times. An
   asset is down until its repair finishes, so a predecessor's downtime
   propagates to every successor through the precedence edges.
2. **Minimize total cost** (费用).
3. **Lexicographically smallest task sequence** (字典序最小任务序列): task ids
   ordered by `(start, crew, id)`, compared by code units.

If no mode assignment fits the budget / parts inventory the state is
**infeasible**; the violation (minimum attainable cost vs. budget, part
shortage) is reported and propagates to every later command step until the
state is fixed.

## Exactness and determinism

`solve()` is an exact branch & bound:

- mode assignments are enumerated with safe suffix-minimum pruning on budget
  and parts;
- for each assignment, schedules are enumerated over topological orders with a
  canonical serial scheme (earliest feasible start, earliest-completing crew,
  ties → lowest crew index), which generates all active schedules and
  therefore contains an optimum;
- the downtime lower bound is the max of a precedence-chain relaxation and a
  capacity relaxation (closed-form SPT optimum on identical crews);
- tie branches (`bound == best`) are always explored, so the cost/sequence
  tie-breaking is exact.

All collections are canonicalized (tasks sorted by id, part keys sorted) and
every iteration order is sorted, so tied optima are reproduced **objectively**
— the result never depends on Map or JSON insertion order. The solver result
carries an optimality **certificate** (method, explored/pruned counts, the
optimum tuple, and a proof sketch).

## Incremental maintenance, undo/redo

`Scheduler` keeps the current state, an undo stack and a redo stack. Commands:

| command | effect |
| --- | --- |
| `{op:"addTask", task}` | add a task (validated: deps exist, acyclic, known parts) |
| `{op:"removeTask", id}` | remove a task; dependency edges to it are stripped (successors are invalidated and rescheduled) |
| `{op:"updateMode", task, mode, patch:{duration?,cost?,parts?}}` | modify a mode |
| `{op:"repriceMode", task, mode, cost}` | shortcut for changing a mode's price |
| `{op:"setBudget", budget}` | adjust the total budget |
| `{op:"undo"}` / `{op:"redo"}` | every command is undoable/redoable |

Solutions are memoized by canonical state hash, so revisiting a state
(undo/redo, reverting edits) is served from the cache without re-solving.
Each step reports a **diff** against the previous step: status changes,
downtime/cost deltas, added/removed/changed intervals, sequence changes — a
budget cut that forces a different mode upstream shows up as changed
(successor) intervals. Failed commands are reported in-band
(`status: "error"`), leave the state untouched and are not undoable.

## CLI

```
node src/cli.js maintenance input.json commands.json -o out.json
```

- `input.json`: `{budget, crews?, parts?, tasks:[{id, deps?, modes:[{duration, cost, parts?}]}]}`
- `commands.json`: an array of commands (or `{"commands": [...]}`)
- `out.json`: `{problem, objectiveOrder, steps:[...], final}`; each step has
  `status`, `schedule` (per-crew non-preemptive intervals, downtime, cost,
  sequence, modes, partsUsed), `criticalConstraints` (binding budget/parts,
  critical path), `diff` and the optimality `certificate`.
- stdout prints one summary line per step; exit codes: `0` ok, `1` invalid
  problem (cyclic DAG, negative budget, unknown spare part, …), `2` usage/IO
  error. Command-level errors stay in-band with exit code `0`.

## Tests / acceptance

```
node --test
```

- `test/solver.test.js` — instances with ≤ 8 tasks compared against an
  independent brute-force reference (`test/brute.js`) that enumerates **all
  mode combinations × all legal topological orders** (plus a second reference
  that also enumerates all crew assignments); determinism under input
  shuffling; infeasibility.
- `test/incremental.test.js` — budget cut triggers a plan change and
  successor invalidation; infeasibility propagates to successor states;
  undo/redo round trips; cache reuse; critical constraints.
- `test/errors.test.js` — cyclic DAG, negative budget, unknown spare parts,
  duplicate tasks, unknown dependencies, schema violations.
- `test/cli.test.js` — end-to-end CLI runs; writes the real stdout, stderr
  and exit code of every run to `test-results.txt`.

`node scripts/record-acceptance.mjs` runs `node --test` and appends the test
run's own real stdout/stderr/exit code to `test-results.txt`.
