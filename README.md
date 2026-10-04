# weighted-rank-lib

Weighted percentile rank index with DAG-derived observation weights, atomic
generation snapshots, and crash-safe persistence. TypeScript + Node.js
built-in modules only, zero runtime dependencies.

## Percentile definition

For a query value `x`:

```
percentile(x) = (W_less + 0.5 * W_equal) / W_total
```

- `W_less`: total weight of observations with value strictly less than `x`
- `W_equal`: total weight of observations with value equal to `x`
- `W_total`: total weight of all observations

An empty set (or zero total weight) returns empty results: `percentileOf`
returns `null`, `scores()` returns an empty map.

## Modules

- `src/rankIndex.ts` — `WeightedRankIndex`: sorted distinct values + Fenwick
  tree over aggregated weights. `set` inserts or exactly replaces an
  observation; `delete` removes exactly the contribution that was added.
- `src/dag.ts` — dependency DAG that derives observation weights from raw
  sources. `DagEngine` evaluates lazily and incrementally (dirty propagation
  along the edges actually used in the previous generation). Conditional
  nodes evaluate their condition dependencies, select a branch, and evaluate
  only that branch's dependencies — unselected branches are never touched.
  `evaluateDagModel` is the independent full-evaluation reference model.
- `src/engine.ts` — `RankedLibrary`: one `commit()` applies a batch of
  source changes, derives all weights, rebuilds every percentile score, and
  atomically publishes one immutable `Snapshot` with a fresh generation
  number. Readers only ever see fully built snapshots via `getSnapshot()`,
  so mixed-generation reads are impossible.
- `src/persistence.ts` — `SnapshotStore`: writes `snapshot.json.tmp`,
  fsyncs, then atomically renames over `snapshot.json`. A crash leaves
  either the old or the new snapshot, never a torn one; leftover `.tmp`
  files are ignored on recovery and a SHA-256 checksum detects corruption
  of the committed file.
- `src/model.ts` — reference models used to cross-check the index:
  `naivePercentiles` (per-item weight accumulation, O(n^2)) and
  `sortingPercentiles` (sort by value + cumulative weight bands).

## Test

```
npm test
```

Compiles with `tsc` and runs `node --test` over `dist/test/*.test.js`.
See `RESULTS.md` for the actual recorded results (20 tests, all passing).
