# graph-replica

Replicated graph library in TypeScript using only Node.js built-in modules
(no runtime or dev dependencies; `tsc` is only used to compile).

## Semantics

- **Tagged adds**: every `addEdge(from, to)` generates a unique tag
  (`<replicaId>#<counter>`). An edge is visible while it has ≥1 live tag.
- **Observed-remove**: `removeEdge(from, to)` removes only the tags observed
  at remove time, so a concurrent add (unknown tag) survives — add-wins.
- **Convergence under unreliable delivery**: messages (`add`/`remove`) may
  arrive out of order or duplicated. Tombstones remember removed tags so a
  late `add` for an already-removed tag is ignored, and `Set`-based apply is
  idempotent. Replicas that see the same message set converge to identical
  state (`stateSignature()`).
- **Projection with cycles**: `projection()` materializes visible edges as an
  adjacency list and may contain cycles. `findCycles()` only *reports*
  cycles (normalized, deduplicated) — it never deletes edges.
- **Independent verification**: `isReachable(from, to)` is a separate BFS
  used to cross-check cycle evidence (each cycle member must reach the next,
  and itself, via a real path).

## Layout

- `src/graph.ts` — `GraphReplica`, message types, cycle report, reachability.
- `test/graph.test.ts` — `node:test` suite (11 tests).
- `types/node-shim.d.ts` — minimal ambient declarations for `node:test` and
  `node:assert/strict` (avoids needing `@types/node`).

## Commands

```sh
npm test        # tsc -p tsconfig.build.json && node --test dist/test/graph.test.js
npm run typecheck
```

## Recorded test results (actual run)

Environment: Node.js v22.22.1, tsc 7.0.2, 2026-10-05.

```
ok 1 - addEdge generates a unique tag per add; edge is visible
ok 2 - removeEdge deletes exactly the tags observed at remove time
ok 3 - concurrent add survives a remove (add-wins)
ok 4 - out-of-order delivery: remove applied before its add still converges
ok 5 - duplicate messages are idempotent
ok 6 - replicas converge under shuffled, duplicated broadcast
ok 7 - projection may contain cycles: reported, never auto-removed
ok 8 - self-loop is reported as a cycle
ok 9 - acyclic projection reports no cycles
ok 10 - independent reachability check verifies cycle evidence
ok 11 - cycle survives in projection after unrelated removes; gone only when its edges are removed
# tests 11
# pass 11
# fail 0
```

`npm run typecheck` (`tsc --noEmit`) also passes.
