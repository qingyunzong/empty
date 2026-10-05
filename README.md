# graph-replica

Replicated graph library (TypeScript, Node.js built-ins only, zero npm
dependencies) with observed-remove edge semantics and cycle reporting.

## Semantics

- **Add generates a tag** — every `addEdge(from, to)` mints a unique tag
  (`<replicaId>#<counter>`); an edge is visible iff it has at least one
  live tag (`src/graph.ts`).
- **Remove only deletes observed tags** — `removeEdge(from, to)` captures
  the tags visible at removal time and the resulting op carries exactly
  those tags; tags it never observed are untouched.
- **Concurrent adds are preserved** — because removes name explicit tags,
  a concurrent add (unknown to the remover) survives: add-wins per tag.
- **Out-of-order / duplicate delivery converges** — ops are idempotent and
  commutative; removed tags are kept as tombstones so a remove that
  arrives before its add still wins once the add lands.
- **Projection may contain cycles** — `project()` yields the visible-edge
  adjacency map; `findCycles()` (DFS, `src/cycles.ts`) only *reports*
  cycles and never deletes edges to break them.
- **Independent reachability check** — `verifyCycleEvidence()` re-validates
  every reported cycle using only BFS reachability (`reachable()`), which
  shares no logic with the DFS detector.

## Layout

- `src/graph.ts` — `GraphReplica`, `AddEdgeOp` / `RemoveEdgeOp`, projection, convergence fingerprint
- `src/cycles.ts` — `findCycles`, `reachable`, `verifyCycleEvidence`
- `test/graph.test.ts` — node:test suite (7 tests)
- `types/node-shims.d.ts` — minimal ambient types for `node:test` / `node:assert` (no @types/node needed)

## Commands

```sh
npm test        # tsc (typecheck + emit to dist/) then node --test
npm run build   # compile only
```

Requires Node.js (developed on v22.22.1) and a `tsc` on PATH
(TypeScript 7.0.2 used). Tests run against compiled JS because this Node
build lacks `--experimental-strip-types` support.

## Test results (actual, 2026-10-05)

`npm test` output:

```
> tsc && node --test dist/test/*.test.js
ok 1 - dist/test/graph.test.js
# pass 1
# fail 0
# duration_ms 435.775972
```

Individual cases (via `node dist/test/graph.test.js`), 7/7 passing:

```
ok 1 - addEdge mints a unique tag per add and exposes the edge
ok 2 - removeEdge only removes tags observed at removal time
ok 3 - concurrent add survives a concurrent remove (add-wins per tag)
ok 4 - replicas converge under out-of-order and duplicate delivery
ok 5 - projection may contain cycles; they are reported, never auto-removed
ok 6 - independent reachability check verifies cycle evidence
ok 7 - acyclic projections report no cycles
# pass 7
# fail 0
```

Note: this Node build's `--test` runner reports file-level results only
(it does not surface child TAP), but the exit code reflects inner
failures — verified while fixing a real convergence bug (missing
tombstones) that the out-of-order test caught.
