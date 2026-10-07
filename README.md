# sched-mvcc

Offline MVCC scheduling store for discrete-manufacturing work orders.
Node.js 22, standard library only, tested with `node:test`. No network.

## Model

- **Multi-version chain**: every commit appends a version `{id, parent, writes}`
  to a chain rooted at the empty genesis version 0. Committed versions are
  appended to `<data-dir>/versions.jsonl` and replayed on open.
- **Snapshot isolation**: `begin()` pins the snapshot to the latest committed
  version. `get` reads that snapshot overlaid with the transaction's own
  writes; later commits never change what an open transaction sees.
- **Commit merge rule**: a commit is rejected with `E_SNAPSHOT` if any key it
  writes was modified by a version committed after its snapshot (an old
  snapshot cannot overwrite a newer version). Writes to disjoint keys merge
  freely, even from a stale snapshot.
- **Secondary unique index (workcenter, timeSlot)**: at commit time the index
  is checked atomically against the committed key space plus the committing
  transaction's writes. Two committed work orders may never occupy the same
  `(workcenter, timeSlot)`; violations fail with `E_UNIQUE`. Only object
  values with string `workcenter` and `timeSlot` fields are indexed;
  zero-length work orders (`""`) and other shapes are not.

## Library API

```js
import { Store, StoreError } from './src/store.js';

const store = Store.open('./sched-data'); // or: new Store() for in-memory
const tx = store.begin();                 // pins snapshot
store.get(tx, 'wo-1');                    // value or null
store.put(tx, 'wo-1', { workcenter: 'wc1', timeSlot: 't1' });
store.commit(tx);                         // -> version id, or throws
store.abort(tx);
```

Errors are `StoreError` with `.code` in
`E_UNIQUE` | `E_SNAPSHOT` | `E_USAGE`.

## CLI

```
node cli.js [--data-dir DIR] < commands.json
```

Reads a JSON array of commands (or newline-delimited JSON) from stdin:

```json
[{"op":"begin"},
 {"op":"put","tx":"tx1","key":"wo-1","value":{"workcenter":"wc1","timeSlot":"t1"}},
 {"op":"commit","tx":"tx1"},
 {"op":"begin"},
 {"op":"get","tx":"tx2","key":"wo-1"},
 {"op":"abort","tx":"tx2"}]
```

Prints one canonical JSON result (sorted keys, no whitespace) per command to
stdout. Exit codes:

- `0` — all commands succeeded
- `1` — a unique (`E_UNIQUE`) or snapshot (`E_SNAPSHOT`) conflict occurred;
  the first error is written to stderr as `{"code","message"}`
- `2` — usage error (bad JSON, unknown op, missing fields, unknown
  transaction); stderr carries `{"code":"E_USAGE","message":...}`

The data dir defaults to `$SCHED_DATA_DIR` or `./sched-data`.

## Tests

```
node --test
```

- `test/acceptance.test.js` — the required acceptance scenarios (concurrent
  slot conflict, disjoint slots, stale-snapshot reads, persistence).
- `test/enumeration.test.js` — exhaustive differential test: all 3276
  histories of ≤2 transactions and ≤4 operations (alphabet includes empty
  key, zero-length work order, duplicate same-value writes, slot collisions)
  checked against a naive copy-array reference (`reference/ref-store.js`).
- `test/edge-cases.test.js` — empty keys, zero-length work orders, duplicate
  writes, index edge cases, abort/usage semantics.
- `test/cli.test.js` — CLI exit codes, canonical output, stderr contract,
  NDJSON input, cross-invocation persistence. Runs in-process through the
  pure `runCli(argv, stdin)` entry point because the dev sandbox blocks
  `child_process`; the process wrapper maps the result verbatim onto
  stdout/stderr/exit code.
