# prereq-sync

Versioned object sync engine with prerequisite-based ordering.

## Semantics

- Every `Change` carries `base` (the version it was built on) and `version`
  (the version the object reaches). A change applies only when the object's
  current cursor equals `base` — i.e. its prerequisite has been applied.
- Out-of-order changes are buffered and drained automatically once their
  prerequisite arrives. Missing prerequisites are never guessed.
- Deletes advance the cursor like any other change; a later `put` based on
  the delete's version can resurrect the object.
- The pending buffer is bounded by `pendingBudget`. When full, `receive`
  returns `{ status: "backpressure" }` and the caller retries later.
  In-order changes never consume budget.
- `snapshot()` / `SyncStore.restore()` preserve both applied state
  (including cursors of deleted objects) and the pending buffer, so
  recovery loses nothing in flight.

## Usage

```ts
import { SyncStore } from "prereq-sync";

const store = new SyncStore<string>({ pendingBudget: 1024 });
store.receive({ objectId: "a", base: 0, version: 1, op: "put", value: "one" });
store.receive({ objectId: "a", base: 1, version: 2, op: "delete" });
```

`receive` returns one of `applied | buffered | duplicate | backpressure`.

## Tests

```
npm test
```

Compiles with `tsc` and runs `node:test` suites, including a randomized
check that shuffled delivery (with deletes, backpressure retries and a
mid-stream snapshot/restore) converges to the same state as sequential
in-order application.

Note: `types/node-shim.d.ts` provides minimal Node typings because this
environment has no network access to install `@types/node`; delete it if
the real types are available.
