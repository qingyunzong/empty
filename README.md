# causal-sync-engine

A TypeScript sync engine that applies object changes in causal order.

## Model

- Every `Change` carries `{ key, version, prev, op, value? }` where `prev`
  names the **predecessor version** that must be applied first.
- A change is applicable iff `change.prev === engine.cursor(change.key)`.
  Only then does the cursor advance to `change.version`.
- Out-of-order changes wait in a bounded pending buffer; when a predecessor
  lands, buffered successors cascade automatically.
- **Deletes advance the version too** (tombstones): a key deleted at v2 keeps
  cursor 2, and a later put at v3 chains onto the tombstone.
- **Missing predecessors are never guessed.** A gap blocks the chain until
  the exact predecessor arrives — nothing is skipped or fabricated.

## Backpressure

The pending buffer has a budget (`maxBuffered`, default 1024). When full,
`receive()` returns `"backpressure"` and **rejects** the change; the caller
must retry after the buffer drains. `budgetRemaining` exposes headroom.

## Snapshot & recovery

`snapshot()` returns plain JSON-serializable data covering applied state,
per-key cursors (including tombstones) and **all pending changes**.
`SyncEngine.restore(snapshot)` rebuilds the engine with the pending buffer
intact, so recovery resumes exactly where the live engine stopped.

## Statuses

`applied` · `buffered` · `duplicate` · `stale` · `backpressure` · `invalid`

## Usage

```ts
import { SyncEngine } from "causal-sync-engine";

const engine = new SyncEngine<string>({ maxBuffered: 256 });
engine.receive({ key: "doc", version: 2, prev: 1, op: "put", value: "b" }); // buffered
engine.receive({ key: "doc", version: 1, prev: 0, op: "put", value: "a" }); // applied, cascades v2
engine.cursor("doc"); // 2
```

## Tests

```
npm test   # tsc + node --test
```

Unit tests cover ordering, tombstones, no-guessing, backpressure, and
snapshot round-trips. Property tests generate random put/delete chains,
shuffle them with seeded PRNGs, and verify the engine converges to a
sequential reference model — including across snapshot/restore mid-stream
and under a 1-slot buffer budget.
