# mold-plan

Offline injection-molding shop scheduler. Node.js 22 standard library only
(`node:fs`, `node:path`, `node:test`, ...); no dependencies, single machine,
fully offline.

## Model

- **Jobs** `{ id, units, eligible: [moldId] }` — work to schedule.
- **Molds** `{ id, life, changeTime }` — `life` caps total units a mold can
  run; `changeTime` is the mold-change (setup) cost charged once per mold per
  shift it runs on.
- **Calendar** — ordered shifts `[{ id, budget }]`, `budget` caps units per
  shift.
- **Cost** — lexicographic `[shiftsUsed, setupTime]`; minimized exactly.

## Solver and tie-break

`src/solver.js` enumerates assignments depth-first with budget/life pruning.
Candidates are ordered by `(shiftIdx, moldIdx)` and the first plan attaining
the best cost is kept, so the output is the lexicographically smallest
assignment vector over jobs sorted by id. Parallel-optimal instances therefore
always produce the same plan (fixed tie-break), independent of job input
order. Cross-checked against brute-force enumeration for `n <= 9`.

## Changes, incremental recompute, rollback

- Changes (`insert`/`assign`/`unassign`, plus mold/shift inserts) are captured
  in batches; every change stores its exact inverse.
- Derived state (mold usage, shift load, mold→shifts, pending, feasibility)
  is recomputed **incrementally** per dirty job; full recompute happens only
  at load/recovery. Tests assert incremental == full after every change.
- **Hierarchical rollback**: rolling back a batch skips changes that touch a
  mold whose maintenance is locked for that batch; if anything is skipped the
  rollback is out of bounds and raises `ROLLBACK` (the locked change — e.g.
  mold maintenance — is preserved).

## Feasibility, certificates, pending

- `feasible=false` when budgets/mold life cannot be met or jobs are
  unassigned; the **last feasible certificate is always retained** and never
  clobbered by later infeasible states.
- Mold over-allocation (e.g. after a sync conflict) is reported as `pending`
  — never silently treated as unsatisfiable.

## Crash points and recovery

Three fault points, each with a distinct recovery rule (`src/store.js`,
`src/journal.js`):

1. **journal append** — append-only JSONL with fsync; recovery replays
   complete records and drops a torn trailing line.
2. **plan.tmp rename** — snapshots are `plan.tmp` + fsync + atomic rename +
   dir fsync; a leftover `plan.tmp` after a crash is **discarded**, committed
   `plan.json` stays authoritative.
3. **budget manifest commit** — `budget.tmp` + fsync + rename; once renamed,
   the committed manifest (`budget.json`) is **preserved** across crashes;
   stale `budget.tmp` is dropped.

## Sync

Two terminals (data directories) exchange incremental batch records
(`syncWorkspaces`). Each batch carries a version-vector stamp
`{terminal, seq}`; already-seen records are skipped, concurrent identical
inserts are idempotent, conflicting assigns resolve deterministically in
version-vector order (later writer wins). After merging, mold over-allocation
surfaces as `pending`.

## CLI

```
mold-plan plan     --dir D [--def file.json] [--lock M1,M2]
mold-plan apply    --dir D [--changes file.json|-]   # stdin default
mold-plan rollback --dir D
mold-plan sync     --dir D --peer P [--terminal TA --peer-terminal TB]
mold-plan verify   --dir D
mold-plan status   --dir D
```

Diagnostics are JSON on **stderr**; results are JSON on stdout.
Exit codes: **2** usage, **3** rollback out of bounds, **6** verify failed.

## Tests (real results)

`node --test` — all suites pass on Node v22.22.1:

```
# tests 6   (files)
# pass 6
# fail 0
```

Individual files: `test/cli.test.js` 9, `test/model.test.js` 7,
`test/recovery.test.js` 5, `test/solver.test.js` 5, `test/sync.test.js` 3,
`test/workspace.test.js` 4 — **33 tests, 33 pass, 0 fail**.

Coverage of the acceptance criteria:

- **预算边界** — `solver.test.js` (load == budget feasible, budget−1
  infeasible; same for mold life) and `cli.test.js` (exact fit then overflow
  keeps certificate).
- **并列最优** — symmetric-mold ties resolve to one canonical plan across
  repeated runs and input reorderings.
- **三故障点** — `recovery.test.js`: torn journal tail replayed/dropped,
  stale `plan.tmp` discarded, committed budget manifest preserved.
- **n≤9 枚举对照** — 60 seeded random instances, solver cost and canonical
  assignment match brute-force enumeration exactly.
