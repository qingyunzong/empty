# maintenance-scheduler

Optimal maintenance scheduling on a task DAG with per-task execution modes,
a fixed total budget, spare-part inventories and 2 interchangeable repair
crews. Pure Node.js 22 standard library; tests use `node:test`.

## Model

- Each **task** has an id, optional predecessor ids (`deps`, must form a DAG),
  a **downtime weight** `downtime` (lost-production units per time unit until
  the task is completed), an optional `deferPenalty` (time units, default
  10000) and one or more **modes**. A mode gives `duration`, `cost` and
  required spare `parts`.
- A task is either **scheduled** (one mode, one crew, one non-preemptive
  interval) or **deferred**. A deferred task contributes
  `downtime * deferPenalty` and **invalidates all of its successors**
  (a task with a deferred predecessor cannot run — deferral propagates
  through the DAG). Predecessor downtime also propagates naturally: a task
  cannot start before all scheduled predecessors finish.
- Constraints: total mode cost `<= budget`; total part consumption per part
  type `<= inventory`; per crew, intervals do not overlap; precedence.
- Objectives, lexicographic:
  1. minimize **total downtime** `sum(w_i * C_i)` over scheduled tasks plus
     deferral penalties,
  2. minimize **total cost**,
  3. **lexicographically smallest task sequence** (task ids ordered by
     `(start, crew, id)`), then a canonical `(mode tuple, crew assignment
     tuple)` tie-break so output is fully deterministic and reproducible
     regardless of JSON key or Map iteration order.

## Optimality certificate

The solver enumerates every (defer | mode) plan with budget/parts prefix
pruning and, per plan, every non-delay schedule via a `(task, crew)` decision
DFS with a lower-bound prune. For the regular objective `sum(w_i*C_i)` an
optimal non-delay schedule always exists (any avoidable idle can be removed
without worsening the objective), so the enumeration is exact. The
`certificate` field reports the enumeration counters and a SHA-256 hash of
the canonical problem. The acceptance tests compare the solver against an
independent reference that enumerates all mode combinations and all legal
topological orders with plain list scheduling.

## Incremental maintenance

`MaintenanceStore` keeps the current validated problem, a command journal
with `past`/`future` stacks (every command — including `undo`/`redo`
themselves — can be undone and redone), and a result cache keyed by the
canonical problem hash, so revisiting states is O(1). Every applied command
returns a structural **diff** (objective deltas plus per-task
added/removed/scheduled/deferred/mode-changed/rescheduled changes).

Commands: `setBudget`, `addTask`, `removeTask` (strips dangling dependency
edges), `updateModeCost`, `undo`, `redo`.

## CLI

```
node src/cli.js maintenance input.json commands.json -o out.json
```

- `input.json`: `{budget, crews?, parts?, tasks: [...]}`.
- `commands.json`: JSON array of commands (may be empty).
- `-o` selects the output file (default: stdout).
- Output: `{initial, steps, final}` where each result contains the per-crew
  non-preemptive intervals, per-task states, downtime, cost, critical
  constraints (binding budget, exhausted parts, zero-slack precedence edges,
  deferred tasks with reasons), the per-step diff and the optimality
  certificate.
- Exit codes: `0` ok, `1` usage/IO error, `2` validation or command error
  (coded message on stderr, e.g. `error[CYCLIC_DAG]: ...`). On a command
  error the failing step is recorded with `status: "error"`, later commands
  are skipped, the output is still written, and the exit code is 2.

## Errors

Coded `ValidationError`s: `CYCLIC_DAG`, `NEGATIVE_BUDGET`, `UNKNOWN_PART`,
`UNKNOWN_DEPENDENCY`, `DUPLICATE_TASK_ID`, `INVALID_*`, `UNKNOWN_COMMAND`,
`UNKNOWN_TASK`, `UNKNOWN_MODE`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO`.

## Tests

```
node --test
```

Covers: solver vs. exhaustive reference enumeration on hand-built and
randomized instances up to 8 tasks; budget cuts triggering plan changes and
successor invalidation; undo/redo; error cases; CLI end-to-end runs including
byte-for-byte reproducibility.
