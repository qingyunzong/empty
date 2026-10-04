# mold-plan

Offline injection-molding shop scheduler. Node.js 22 standard library only;
tests use `node:test`. No dependencies, no network.

## Model

- **Jobs** `{mold, shots, duration}` — consume mold life (shots) and shift
  capacity (minutes).
- **Molds** `{life}` — global shot budget across all shifts.
- **Calendar** — shifts `{capacity}` in minutes; maintenance windows
  `{id, mold, shift, duration, locked}` consume shift capacity.
- **Budget** — shift capacities + mold lives, committed as a manifest.
- **Changeovers** — `setup[mold]` for the first job of a shift,
  `changeover[from][to]` between consecutive jobs of different molds.

Objective: minimize total setup + changeover minutes. Ties are broken by the
lexicographically smallest canonical plan string (`SHIFT:JOB,JOB|...`), so
tied optima always produce the same plan regardless of insertion order.

## Library

- `src/solver.js` — exact subset-DP solver (assignment DP × per-shift ordering
  DP), content-keyed memo tables for incremental recompute.
- `src/planner.js` — change capture (`insert` / `assign` / `unassign` /
  `maintenance` / `pend` / budget ops), journaled and applied with targeted
  memo invalidation (never a full rebuild); hierarchical batch rollback that
  preserves locked mold maintenance and raises `ROLLBACK` (exit 6) when the
  depth is out of bounds; `feasible=false` retains the last feasible
  certificate; `pending` jobs are excluded from the problem, never treated as
  unsatisfiable.
- `src/journal.js` / `src/store.js` — append-only journal, `plan.tmp`+rename
  plan persistence, two-phase budget manifest commit. Recovery: torn journal
  tails are truncated and the valid prefix replayed; orphan `plan.tmp` is
  discarded; the last committed budget manifest is authoritative.
- `src/sync.js` — bidirectional delta exchange between two terminal
  directories. Ops carry `(term, counter)` stamps and version vectors;
  conflicts resolve by vv-dominance with a deterministic `(counter, term)`
  tie-break; resource over-allocation after a merge is demoted to `pending`.

## CLI

```
mold-plan plan     --state DIR
mold-plan apply    --state DIR --op <shift|mold|setup|changeover|insert|assign|unassign|maintenance|pend|unpend> [fields]
mold-plan rollback --state DIR [--n K]
mold-plan sync     --state DIR --peer DIR
mold-plan verify   --state DIR
```

Results are JSON on stdout. Errors are JSON on stderr
(`{"error":{"code","message"}}`) with exit codes: `2` usage/corruption,
`3` infeasible budget, `6` rollback out of bounds.

## Tests

```
node --test
```

Covers: budget boundaries (exact fit vs one unit short), tie-break stability,
three fault points (journal append / plan.tmp rename / budget commit),
incremental vs full recompute equivalence, hierarchical rollback, sync
convergence with pending demotion, CLI exit codes, and a brute-force
enumeration cross-check of the solver for all n ≤ 9. See `RESULTS.md`.
