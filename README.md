# hash-ring-router

Versioned consistent-hash routing ring (TypeScript, zero dependencies).

## Design

- **Hash adapter** (`src/hash.ts`): pluggable `HashAdapter` / `AsyncHashAdapter`
  map vnode keys (`<nodeId>#<replica>`) to uint32 positions.
- **Ring** (`src/ring.ts`): virtual nodes sorted by `(hash, nodeId, replica)` —
  hash collisions are broken by node id, then replica index. `ownerOfHash` is a
  binary search over distinct hashes; `replicasOfHash` walks the ring and only
  returns distinct physical nodes. An empty ring routes nothing.
- **Builder** (`src/builder.ts`): `RingBuilder` computes vnode hashes
  asynchronously through `SharedHashComputer`, which deduplicates identical
  in-flight computations across builds and aborts the underlying computation
  only when its last subscriber cancels. Every build carries an epoch; when a
  newer build starts, the old one is aborted and rejects with
  `StaleBuildError`, so stale hash results can never enter a newer ring.
- **Router / Cursor** (`src/router.ts`): `publish` applies a config as a new
  monotonically increasing ring version. Cursors acquired earlier keep routing
  against the ring version they were acquired on until released.
- **Migration** (`src/migration.ts`): `planMigration(oldRing, newRing)` takes
  the union of both rings' ownership boundaries and emits the exact key
  intervals `(start, end]` (wrapping at 2^32, `start === end` = full ring)
  whose owner changed, including collision tie-break effects. Removing a node
  therefore migrates exactly the keys it used to own.

## Usage

```ts
import { Fnv1aAdapter, RingBuilder, Router, SharedHashComputer, SyncAsyncHashAdapter, planMigration } from './src/index.js';

const computer = new SharedHashComputer(new SyncAsyncHashAdapter(new Fnv1aAdapter()));
const router = new Router(new RingBuilder(computer, 16));

const ring1 = await router.publish([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]);
const cursor = router.acquireCursor();          // pinned to ring v1
const ring2 = await router.publish([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }]);
const plan = planMigration(ring1, ring2);       // exact key intervals to move
cursor.route('user-42', new Fnv1aAdapter());    // still answered by ring v1
cursor.release();
```

## Tests

```
npm test
```

Compiles with `tsc` and runs `node --test`. Covers deliberate hash collisions,
empty rings, randomized cross-checks against a fully-sorted reference ring,
exact migration diffs (including node removal and weight changes), and
barrier-driven async tests for stale-result rejection and shared-computation
cancellation.
