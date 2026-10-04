# Test results

Command: `npm test` (= `tsc -p tsconfig.json && node --test dist/test/*.test.js`)

Environment: Node.js v22.22.1, TypeScript 7.0.2, recorded 2026-10-05.

## Summary (actual output)

```
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 264.562306
```

All 4 test files pass — 20 individual tests, 0 failures:

```
== dist/test/dag.test.js
ok 1 - conditional dependencies evaluate only the selected branch
ok 2 - unselected branch with a throwing compute is never touched
ok 3 - incremental recomputation only touches dirty nodes
ok 4 - incremental engine matches full-evaluation model under random source changes
ok 5 - cycles and unknown references are rejected
# pass 5 / 5

== dist/test/engine.test.js
ok 1 - one commit updates weights and all percentiles as a single generation
ok 2 - snapshot is frozen and detached from later commits
ok 3 - failed commit leaves the previous generation intact
ok 4 - weights match full DAG evaluation; scores match both models (randomized)
ok 5 - empty observation set yields empty scores after commit
# pass 5 / 5

== dist/test/persistence.test.js
ok 1 - recovery after failure restores the same snapshot
ok 2 - a torn temporary file from a crashed write is ignored
ok 3 - corrupted committed snapshot is detected via checksum
ok 4 - loading from an empty directory returns null
# pass 4 / 4

== dist/test/rankIndex.test.js
ok 1 - percentile = (strictly-less weight + half equal weight) / total weight
ok 2 - equal values share half of their combined weight
ok 3 - empty set returns empty results
ok 4 - updates and deletes are exact
ok 5 - rejects invalid input
ok 6 - randomized ops cross-checked against per-item accumulation and sorting models
# pass 6 / 6
```

## What is verified

- Percentile formula `(W_less + 0.5 * W_equal) / W_total`, including ties.
- Empty set / zero total weight returns empty results.
- Updates and deletes are exact (no residual weight; totals return to zero).
- 800 randomized set/delete operations cross-checked every 20 steps against
  both the per-item accumulation model and the sorting model.
- Conditional DAG dependencies evaluate only the selected branch (verified
  with call counters and a throwing unselected branch).
- Incremental DAG engine matches the full-evaluation model over 100 rounds
  of random source changes; only dirty nodes are recomputed.
- One commit updates weights and all percentiles as a single generation;
  snapshots are frozen and detached, so mixed-generation reads are
  impossible; a failed commit leaves the previous generation intact.
- 60 randomized commits: snapshot weights exactly match a full DAG
  evaluation; scores match both percentile models.
- Persistence: recovery after a simulated failure restores the same
  snapshot (same generation, weights, scores), cross-checked with a full
  DAG evaluation and the sorting model; torn `.tmp` files are ignored;
  checksum mismatch on the committed file is detected.
