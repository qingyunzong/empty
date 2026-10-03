# line-scheduler

Offline, single-machine, multi-line discrete-slot scheduler with provable
results. Node.js 22 standard library only; tests use `node:test`.

## Model

- Time is discrete slots `0, 1, 2, ...`; a task occupies
  `[start, start + duration)`.
- Task: `id`, `line`, `duration`, `release` (`null` = available at 0),
  `due` (`null` = no deadline). `release <= start` and
  `start + duration <= due` are hard constraints.
- `precedence`: `[before, after]` pairs; `before` must end before `after`
  starts.
- `capacity`: per line, per slot, `capacity[line][slot]` overrides;
  `capacity[line]["*"]` sets a line default; global default is 1.
- Objective: among feasible schedules minimize the maximum lateness
  `max(completion - due)`; ties are broken by the lexicographically smallest
  start-time vector in ascending task-id order.

## Guarantees

- The solver (`src/solve.js` `solve`) is an exhaustive depth-first
  enumeration with safe pruning — never a timeout — so `feasible: false` is
  a proof of infeasibility.
- `bruteForce` is an independent reference that enumerates every slot
  assignment; the test-suite cross-validates both on random instances of
  up to 8 tasks.
- Infeasible runs return a *minimal infeasible constraint subset*
  (irreducible: removing any single constraint restores feasibility) as a
  certificate.
- `apply` reports the new schedule, the affected operation set (directly
  edited tasks, tasks on capacity-cut slots, and the transitive precedence
  closure), and whether a local repair (re-solving only affected tasks with
  all others frozen) already reaches the global optimum.
- `undo`/`redo` restore the full problem, solution and both stacks.

## CLI

```
node cli.js schedule <problem.json> [--state path]   # solve, persist state
node cli.js apply <edit.json> [--state path]         # edit + re-solve
node cli.js undo [--state path]
node cli.js redo [--state path]
```

Exit codes: `0` feasible, `1` infeasible (certificate printed),
`2` usage/runtime error. Use `-` instead of a file to read JSON from stdin.
State defaults to `.sched-state.json`.

Edit ops:

```json
{ "op": "upsertTask", "task": { "id": "a", "line": "L1", "duration": 2, "release": null, "due": 5 } }
{ "op": "deleteTask", "id": "a" }
{ "op": "addPrecedence", "before": "a", "after": "b" }
{ "op": "removePrecedence", "before": "a", "after": "b" }
{ "op": "setCapacity", "line": "L1", "slot": 3, "capacity": 0 }
{ "op": "setCapacity", "line": "L1", "slot": null, "capacity": 2 }
```

Batch edits: `{ "ops": [ ... ] }`.

## Development

```
node --test            # run the test suite
scripts/acceptance.sh  # regenerate result.txt (tests + CLI acceptance runs)
```
