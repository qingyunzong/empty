# RESULTS

Date: 2026-10-03. Environment: Node.js v22.22.1, standard library only.
Command: `node --test` (all 5 test files, 27 tests total).

## Summary

```
# tests 5 (files) / 27 (individual tests)
# pass 5 / 27
# fail 0
# duration_ms ~12.8s (full run)
```

Per-file (node --test --test-reporter=spec):

```
✔ test/budget.test.js  (6 tests)
✔ test/cli.test.js     (7 tests)
✔ test/merge.test.js   (7 tests)
✔ test/rules.test.js   (4 tests)
✔ test/solver.test.js  (3 tests)
```

## Acceptance criteria coverage

1. **Optimality vs brute force (<= 10 variables)** — `test/solver.test.js`:
   400 random instances (1-10 vars, domains of size 2-4, mixed
   range/leq/eq/sumLeq rules, random budgets) plus 150 unbounded instances,
   each compared against an independent full-enumeration reference. Solver
   cost and feasibility agree on every instance; both feasible and
   infeasible populations are exercised (asserted >50 and >10).
2. **Rule cycles** — `test/rules.test.js`: 3-node cycle and self-loop both
   raise `RULE_CYCLE` with the cycle path; acyclic graphs topologically sort
   dependencies-first. CLI path covered in `test/cli.test.js`.
3. **Commutative merge + replayable explain** — `test/merge.test.js`:
   concurrent repairs merge to deep-equal results in both orders (including
   conflicting writes resolved deterministically); `explain` replays the full
   genesis/repair/merge history and verifies data, vector clock and content
   hash. Tampered data and forged repair events raise `HISTORY_CONFLICT`.
4. **Budget boundaries** — `test/budget.test.js`: budget 0 with valid data
   repairs at cost 0; budget 0 with violated data is infeasible; budget
   exactly equal to the minimum cost (4) succeeds while budget 3 is
   `NO_FEASIBLE`; per-variable costs shift the optimum across the boundary.
   Node-limit abort raises `SEARCH_LIMIT`, never `NO_FEASIBLE`.

## Notes

- The CLI is also exercised end-to-end via `execute(argv)` in
  `test/cli.test.js` (the sandbox forbids spawning child processes; the bin
  wrapper in `src/cli.js` uses the identical code path and was verified
  manually: exit 0 with JSON on stdout, exit 1 with JSON error on stderr).
- `NO_FEASIBLE` is only emitted after complete enumeration of the finite
  search space; `--max-nodes` produces `SEARCH_LIMIT` instead.
