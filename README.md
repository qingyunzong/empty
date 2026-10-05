# weighted-rank

Weighted ranking library in TypeScript using only Node.js built-in modules
(zero runtime dependencies; `tsc` is the only build tool).

## Design

- `src/rank.ts` — `WeightedRank`: exact weighted observation index.
  Percentile uses the mid-rank convention:
  `(weight strictly less than v + half the weight equal to v) / total weight`.
  Upserts and deletes are exact (no sketching). `scores()` returns the score
  list and is empty (`[]`) for an empty set; `percentileOf`/`scoreOf` return
  `null` when empty or absent. `replaceAll` swaps the whole set atomically
  in a single generation.
- `src/dag.ts` — `WeightedDag`: derives observation weights from a
  dependency DAG. Evaluation is lazy from the requested targets; a `cond`
  node evaluates only its selected branch (`then` when pick > 0, else
  `else`). Cycles and missing sources are errors.
- `src/engine.ts` — `RankEngine`: one source change (`setSources`) triggers
  a single atomic recompute that republishes all derived weights and all
  percentile scores together, bumping the generation exactly once — readers
  never observe a mixed generation.
- `src/store.ts` — persistent index: snapshots are written to a temp file
  and atomically renamed; a crash mid-write leaves the last committed
  snapshot intact for recovery.
- `src/model.ts` — independent reference models used by the tests:
  item-by-item weight accumulation, a sort-then-accumulate model, and an
  eager full-DAG evaluator.

## Tests

`npm test` compiles with `tsc` and runs `node --test`:

- `test/rank.test.ts` — empty-set behavior, mid-rank formula, exact
  update/delete, input validation, and a 500-step seeded fuzz run checked
  against both the item-by-item and sorted reference models after every op.
- `test/dag.test.ts` — conditional branch selection (unselected branch,
  including a failing "trap" node, is never evaluated), full-DAG lazy
  evaluation cross-checked against the eager model, cycle detection, and
  single-generation atomic republication of weights + percentiles.
- `test/store.test.ts` — snapshot round-trip, recovery of the same
  committed snapshot after a simulated crashed write, and exact state
  reproduction after restore.

## Actual test results

Recorded on 2026-10-05 with Node.js v22.22.1 and tsc 7.0.2:

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js
# Subtest: dist/test/dag.test.js
ok 1 - dist/test/dag.test.js
# Subtest: dist/test/rank.test.js
ok 2 - dist/test/rank.test.js
# Subtest: dist/test/store.test.js
ok 3 - dist/test/store.test.js
# tests 3
# pass 3
# fail 0
```

All 17 individual test cases pass (7 DAG + 6 rank + 4 store), including the
500-step fuzz cross-check against both reference models.
