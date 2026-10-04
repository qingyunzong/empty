# starcatsolve

Incremental, explainable, replayable star-catalog maintenance for an
observatory night system. Reads a JSONL event stream (new photometry,
retractions, corrections, checkpoints, undo, solve) and maintains the current
catalog as a finite-domain CSP — without interrupting observations and without
full recomputation.

Node.js 22, standard library only, tests with `node:test`.

## Layout

- `src/model.js` — plain-data catalog state; incremental `applyAdd` /
  `applyRetract` / `applyCorrect` (a correction touches only the affected
  `(night, star)` domain entry).
- `src/validate.js` — event validation; every violation is an `InputError`.
- `src/solver.js` — finite-domain propagation (singleton assignment,
  all-different pruning, Hall check) + chronological backtracking, dual
  budgets, deletion-minimal UNSAT cores.
- `src/engine.js` — event log, checkpoint stack, `undo_to`, solve
  orchestration, reassignment diffing, `replay()`.
- `src/enumerator.js` — built-in brute-force enumerator used as ground truth
  by the test-suite.
- `src/cli.js` — the CLI.

## Event model

Optional first line: `{"type":"config","coordBins":C,"magBins":M,"capacity":K}`.
A *cell* is `(coord, mag)` with `cell = coord * magBins + mag`. Each night is
an independent CSP; the budget is shared across nights.

```jsonl
{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":2,"mag":1,"conf":0.9}
{"type":"retract_obs","id":"o1"}
{"type":"correct_obs","id":"o1","coord":3,"conf":0.7}
{"type":"checkpoint","name":"cp1"}
{"type":"undo_to","name":"cp1"}
{"type":"solve","budget":{"propagation":1000,"backtrack":100}}
```

- Each star present on a night is a variable; its domain is the set of cells
  claimed by its active observations that night. The chosen cell is the
  catalog entry; observations on other cells are reported as `superseded`.
- `correct_obs` may change `coord`, `mag`, `conf`, `ts` (id/star/night are
  immutable) and propagates incrementally.
- `undo_to` restores the **top** of the checkpoint stack only. Naming a deeper
  checkpoint rolls back just to the nearest consistent point and emits
  `warning: "UNDO_LEVEL_SKIP"`; an unknown name is invalid input.

## Constraints

- `unique_key` — at most one active observation per `(star, night, cell)`
  (observation ids are also unique, enforced at ingest).
- `time_order` — per star, `ts` is non-decreasing in event order.
- `exclusive_cell` — per night, at most one star per cell (all-different).
- `night_capacity` — per night, at most `capacity` stars.

## Solve results

- `SAT` — `model` (per night, per star: cell/coord/mag/representative obs),
  `cells`, `superseded`, `reassignments` (diff vs. previous SAT model with
  the triggering events), and an `explanation` trace of
  assign/prune/branch/conflict steps naming constraints and event indices.
- `UNSAT` — `conflict` plus `unsatCore`: a deletion-minimal subset
  (`obs`, event indices, constraint names) that is UNSAT by itself.
- `PENDING` — budget exhausted (`reason: "BUDGET_EXCEEDED"`, `exceeded:
  "propagation"|"backtrack"`). PENDING is never UNSAT: propagated facts are
  kept in `partial` (`completedNights`, `inProgress` domains/assignments).

Budgets are charged separately: one unit per propagation step
(`budget.propagation`) and one per backtrack node (`budget.backtrack`).

## CLI

```
node src/cli.js [events.jsonl] [--budget-propagation N] [--budget-backtrack N]
```

Reads a file or stdin, prints one JSON object per line (`ack`, `undo`,
`solve_result`, or `error`). Exit codes: `0` ok/SAT, `2` invalid input
(JSON error on stdout), `3` any solve UNSAT, `4` any solve PENDING.

## Tests

```
node --test
```

See `RESULTS.md` for the real output. The suite covers the four acceptance
criteria: chained reassignment after a correction with conflict explanation;
undo-to-intermediate-checkpoint equivalence with from-scratch replay;
state-by-state cross-check of random `n <= 9` event sequences against the
built-in enumerator; and budget-boundary PENDING (never UNSAT).
