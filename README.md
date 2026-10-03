# maintpack

Offline device maintenance package selection library and CLI (Node.js 22, no dependencies).

Each task has an `id`, a `priority`, a cost interval `[cl, ch]` and a duration
interval `[dl, dh]` — all exact rationals — plus optional `precedence` (ids of
prerequisite tasks). A selection is feasible when:

- the sum of worst-case costs (`ch`) is `<= budget` (equality is accepted),
- the sum of worst-case durations (`dh`) is `<= durationLimit` (equality accepted),
- it is closed under precedence (selecting a task selects all its ancestors).

The solver maximizes total priority; ties are broken by the lexicographically
smallest sorted id sequence (numbers sort numerically before strings).

## CLI

Reads JSON commands from stdin — a single object, a JSON array of commands, or
newline-delimited JSON — and prints one JSON result per command:

```sh
echo '[{"op":"import","tasks":[{"id":"a","priority":"3/2","cost":["1/2",1],"duration":[0,1]}]},
       {"op":"solve","budget":2,"durationLimit":5}]' | node src/cli.js
```

Commands: `import` (atomic batch), `solve`, `undo`, `redo`, `list`.

Rationals may be given as numbers, `"3/4"`, `"1.25"`, `"1e-3"`, integers.
`solve` returns the selected ids, exact priority sum, exact cost/duration
interval sums, per-task reasons for non-selection (`cost_budget`,
`duration_limit`, `priority_tradeoff`) and an enumeration certificate.

Error codes: `E_RATIONAL` (invalid fraction), `E_UNSAT` (no feasible
selection), `E_INTERVAL` (`cl > ch`), `E_DUPLICATE`, `E_CYCLE`,
`E_UNKNOWN_PRECEDENT`, `E_HISTORY`, `E_COMMAND`, `E_JSON`.

## Library

- `src/rational.js` — exact BigInt-backed `Rational`
- `src/solver.js` — `solve(tasks, budget, limit)` (exact enumeration)
- `src/store.js` — transactional `Store` with `importBatch` / `undo` / `redo`
- `src/app.js` — stdin payload -> results pipeline (`runCommands`)

Batch import is atomic: any invalid rational, `cl > ch`, duplicate id, unknown
precedent or precedence cycle rolls the whole batch back, leaving previously
committed state (and its executable plan) untouched. Committed imports support
`undo`/`redo`.

## Tests

```sh
node --test
```

Includes a cross-check of the solver against an independent brute-force oracle
on randomized instances with `n <= 9`, boundary tests (worst-case cost exactly
equal to the budget is accepted), cycle-rollback, undo-to-empty-state and CLI
pipeline tests.
