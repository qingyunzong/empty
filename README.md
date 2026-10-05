# gridmap

Obstacle grid library (Go standard library only).

- **Batch obstacle edits**: `Map.Apply(edits ...Edit) *Map` applies a batch
  and returns a new immutable map; the receiver is untouched, so every
  earlier `*Map` remains a queryable snapshot.
- **Shortest path**: 8-neighbor movement; diagonal moves are forbidden when
  either orthogonal cell beside the corner is blocked (no corner cutting).
  Integer costs: orthogonal 10, diagonal 14.
- **Tie-breaking**: among minimum-cost paths, the lexicographically smallest
  full coordinate sequence (points ordered by X, then Y) is returned, via
  reverse Dijkstra labels plus greedy prefix-minimal walk.
- **Distance certificate**: `ShortestPath` returns a `Certificate` (path +
  Dijkstra labels); `Certificate.Verify` independently checks the exhibited
  path cost (upper bound) and a closed consistent label potential (lower
  bound), proving the distance.

## Verification

Randomized tests cross-check the library against an independent full
Dijkstra (random maps, random batch edits, all old snapshots queried) and
against exhaustive enumeration of all minimum-cost simple paths on small
maps (exact lexicographic tie-break check). Certificate accept/reject,
corner-cutting, snapshot isolation, and degenerate cases are unit-tested.

Actual recorded result (`go test ./... -count=1`, go1.27.1 linux/amd64):

```
=== RUN   TestCornerCuttingForbidden
--- PASS: TestCornerCuttingForbidden (0.00s)
=== RUN   TestBatchEditAndSnapshotIsolation
--- PASS: TestBatchEditAndSnapshotIsolation (0.00s)
=== RUN   TestLexicographicTieBreak
--- PASS: TestLexicographicTieBreak (0.00s)
=== RUN   TestCertificateVerify
--- PASS: TestCertificateVerify (0.00s)
=== RUN   TestSameStartGoal
--- PASS: TestSameStartGoal (0.00s)
=== RUN   TestRandomUpdatesVsFullDijkstra
--- PASS: TestRandomUpdatesVsFullDijkstra (0.16s)
=== RUN   TestSmallMapsVsExhaustiveEnumeration
--- PASS: TestSmallMapsVsExhaustiveEnumeration (0.00s)
PASS
ok  	gridmap	0.170s
```
