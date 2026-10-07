# consistent-hash-router

Consistent-hash routing library in TypeScript: virtual-node rings, versioned
publishing, read cursors, and exact migration plans. Zero runtime
dependencies; tests run on the built-in Node test runner.

## Design

- **Hash adapter** (`src/hash.ts`): pluggable `HashAdapter.hash(input)` may be
  sync or async and receives an `AbortSignal`. Ring builds hash vnode inputs
  `"<nodeId>#<replicaIndex>"`; cursors hash keys.
- **Ring** (`src/ring.ts`): vnodes sorted by `(hash, nodeId, replicaIndex)` —
  hash collisions are tie-broken by node id, then replica index, so
  deliberately-colliding adapters stay deterministic. Lookup is a binary
  search for the successor vnode; `owners(hash, n)` walks clockwise and
  returns only distinct physical nodes.
- **Router** (`src/router.ts`): every `setNodes` (membership or weight
  change) builds a new ring asynchronously and publishes it as a new version.
  Publication is guarded by an epoch counter, so stale async hash results can
  never enter a newer ring. In-flight hash computations are shared between
  overlapping builds (refcounted) and cancelled once their last consumer is
  gone; completed hashes are cached. `acquireCursor()` pins the current
  version — cursors keep routing with the old configuration after newer
  versions are published.
- **Migration plan** (`src/migration.ts`): `planMigration(oldRing, newRing)`
  computes the exact `(from, to]` hash intervals whose owner changed, merging
  adjacent intervals (including across the wrap point). Deleting a node
  therefore migrates exactly the keys that belonged to it.

## Tests

```
npm test
```

Compiles with `tsc` and runs `node --test`. The suite covers: deliberate
hash collisions, empty rings, cross-checking against a fully-sorted reference
ring, deletion-only migration, exact interval diffs, versioned publishing
with stale-result exclusion, refcounted shared-computation cancellation
(verified with barriers/gates), and read cursors pinning old configurations.
