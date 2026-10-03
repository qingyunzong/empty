# Provable Workshop Scheduler

Offline, single-machine-shop scheduling library and CLI with **provable**
results: exact enumeration of all integer start-time assignments, minimizing
maximum lateness with a lexicographic tie-break, and minimum infeasible
constraint subsets as certificates. Node.js 22 standard library only;
tests use `node:test`.

## Model

A workshop description is JSON:

```json
{
  "tasks": [
    { "id": "a", "line": "L1", "duration": 2, "release": null, "due": 4 }
  ],
  "precedence": [["a", "b"]],
  "capacity": { "L1": [{ "start": 0, "end": 8, "capacity": 1 }] }
}
```

- `release: null` means available at time 0; `due: null` means no deadline.
- `due` is a **hard constraint**: a schedule is feasible only if every task
  finishes by its due time. Among feasible schedules the solver minimizes the
  maximum lateness `Lmax = max(end_i - due_i)`, breaking ties by the
  lexicographically smallest start-time vector in ascending task-id order.
- `capacity` windows are per line and may overlap (capacities add up). A line
  with no windows defaults to capacity 1 at all times; a line with windows has
  capacity 0 outside them.
- `precedence: [["a","b"]]` requires `end(a) <= start(b)`, also across lines.

## CLI

```
node src/cli.js schedule --file workshop.json [--state state.json]
node src/cli.js apply --state state.json --op '<json>'   # ops below
node src/cli.js undo  --state state.json
node src/cli.js redo  --state state.json
```

Operations for `apply`:

- `{"op":"upsertTask","task":{...}}` — insert or correct a task
- `{"op":"removeTask","id":"a"}` — delete a task (and its precedence edges)
- `{"op":"setPrecedence","edges":[["a","b"]]}`
- `{"op":"setCapacity","capacity":{"L1":[...]}}` — merge capacity windows

Every `apply`/`undo`/`redo` re-optimizes and prints the new schedule, the set
of affected task ids (`affected`), whether a purely local repair would have
sufficed (`localRepairSufficient`), and the undo/redo stack depths. With
`--state`, the workshop plus the full undo/redo log persist across
invocations, so `undo`/`redo` restore complete schedules and stack state.

Exit codes: `0` on success (including infeasible schedules, which are a
valid, certified result), `1` on usage/model errors (message on stderr).

## Solver guarantees

- **Complete enumeration**: the solver enumerates all *active* schedules
  (serial schedule-generation scheme branching over every available task at
  its earliest feasible start) — a finite space that provably contains the
  lexicographically smallest optimum, so infeasibility is *proven*, never
  inferred from a timeout. A `full` mode enumerating every feasible
  start-time assignment is available as the reference algorithm for small
  instances (`enumerateAll(state, { mode: 'full' })`); both modes agree on
  feasibility and the optimum (cross-validated by randomized tests).
  Reference scale: ≤ 8 tasks.
- **Certificate**: for infeasible inputs the CLI returns a minimum
  (irreducible) subset of constraints — tasks, precedence edges, capacity
  windows — that is still infeasible, computed by greedy deletion with an
  exact feasibility oracle.

## Development

```
node --test                      # run the test suite
node scripts/run-acceptance.mjs  # run acceptance scenarios, writes result.txt
```

Layout: `src/model.js` (validation, snapshots, operation log),
`src/solver.js` (enumeration, certificates, diffing), `src/engine.js`
(state + undo/redo + persistence), `src/cli.js` (command line).
