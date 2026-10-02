# Test Results

Environment: Node.js v22.22.1, standard library only, `node:test` runner.
Command: `node --test` (run 2026-10-03).

## Summary

```
ok 1 - test/cli.test.js
ok 2 - test/helpers.js
ok 3 - test/plan.test.js
ok 4 - test/rules.test.js
ok 5 - test/version.test.js
# tests 5
# pass 5
# fail 0
# duration_ms ~12000
```

23/23 subtests pass across 4 test files (`test/helpers.js` contains no tests).

## Subtests

**test/plan.test.js** — acceptance criteria 1 & 4
- `optimal plan cost matches brute-force enumeration for <=10 variables`:
  60 seeded random instances (2–10 variables, domain size 3, 5 rules);
  library optimum equals an independent brute-force oracle in every trial,
  including the cases where the oracle proves nothing feasible within budget.
- `budget 0: only the zero-cost (unchanged) plan can be feasible`: dirty data
  at budget 0 -> `NO_FEASIBLE`; clean data at budget 0 -> empty plan, cost 0.
- `budget boundary: cost exactly equal to budget is feasible`: cost == budget
  accepted; budget - 1 -> `NO_FEASIBLE` after exhaustive proof.
- `SEARCH_LIMIT is never reported as NO_FEASIBLE`: a capped search aborts
  with `SEARCH_LIMIT` ("not a proof of infeasibility"), never `NO_FEASIBLE`.
- `NO_FEASIBLE only after exhaustive proof over the full state space`.
- `plans are ranked by (resolved desc, cost asc, hash asc)`.
- `plan rejects cyclic rules with RULE_CYCLE before searching`.

**test/rules.test.js** — acceptance criterion 2
- Cycle (A->B->C->A) and self-dependency both rejected with `RULE_CYCLE`.
- Acyclic graphs yield a deterministic topological order; `check` reports
  violations in dependency order.

**test/version.test.js** — acceptance criterion 3
- `repair` emits a new causal successor (vector clock strictly dominates the
  parent, parent id linked).
- Concurrent repairs merge commutatively: `merge(a,b)` deep-equals
  `merge(b,a)`; fast-forward when one clock dominates.
- Same variable changed differently on concurrent branches ->
  `HISTORY_CONFLICT`.
- `explain` replays merged history deterministically (two runs identical)
  and the replayed final state matches the merged version.

**test/cli.test.js** — CLI dispatch (in-process; the sandbox forbids
spawning child node processes, so `bin/dq.js` IO is verified via shell)
- All five commands (`check/plan/repair/merge/explain`) plus `init` exposed.
- JSON round-trips for check/repair/merge/explain; stable error codes
  `RULE_CYCLE`, `NO_FEASIBLE`, `HISTORY_CONFLICT`, `BAD_INPUT`.

## CLI smoke (via shell, real processes)

- `init -> repair -> repair -> merge -> explain` pipeline produced
  `merged data: {"t":1,"p":1}` and
  `explain kinds: base,repair,repair,merge final: {"t":1,"p":1} matches: true`.
- Cyclic rules: stderr `{"error":"RULE_CYCLE",...}`, exit code 1.
- Unsatisfiable budget: stderr `{"error":"NO_FEASIBLE","message":"exhaustive
  search over 2 states proved no plan with cost <= 2 exists",...}`, exit 1.
