# generation-router

TypeScript routing library: sessions bind to a node's generation, fail over
only on failure, and health events apply atomically in batches.

## Semantics

- **Generation binding** — each session records `(nodeId, generation)`; a
  node's generation increments on every applied health event and its load
  counter resets.
- **Weighted least-load** — new sessions and reconnects pick the healthy node
  with minimal `load / weight` (ties by node id).
- **Failover only on failure** — sessions never move unless `reconnect()` is
  called; a recovering node does not steal existing sessions.
- **Generation-scoped close** — `closeSession()` decrements load only when the
  bound generation is still the node's current one; stale closes are no-ops.
- **Atomic batches** — `applyHealthEvents()` validates and applies on a private
  copy; any invalid event rejects the whole batch with state untouched.
- **Session-table verification** — `verify()` recomputes per-generation load
  from the session table (covering reconnects and stale closes); `reconcile()`
  repairs drifted counters.

## Usage

```ts
import { GenerationRouter } from "generation-router";

const router = new GenerationRouter([
  { id: "a", weight: 1 },
  { id: "b", weight: 3 },
]);

const s = router.openSession();        // -> { id, nodeId, generation }
router.applyHealthEvents([{ type: "down", nodeId: s.nodeId }]);
router.reconnect(s.id);                // weighted least-load healthy node
router.closeSession(s.id);
router.verify();                       // { ok: true, discrepancies: [] }
```

## Test

```sh
npm test   # tsc + node --test
```
