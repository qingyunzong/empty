# rollback-dsu

Rollback-capable union-find (TypeScript).

- `merge(a, b)` — union two components; every call, including repeated
  merges of already-connected members, occupies one operation slot.
- `snapshot()` — push a snapshot, returns a token.
- `rollback(token?)` — undo all merges recorded after the latest (or the
  given) snapshot; repeated-merge slots are consumed too.
- `find(x)` — component identity = minimum member id.

Rollback safety: no path compression (parent links are only redirected by
`merge` and restored by `rollback`); union by size keeps `find` at O(log n).

## Test

```
npm test
```

Compiles with `tsc` and runs deterministic unit tests plus a randomized
test that cross-checks every operation against a reference model which
truncates its merge log on rollback and rebuilds the connectivity graph
(BFS) from scratch per snapshot state.
