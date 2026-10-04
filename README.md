# workshop-mvcc

Offline, single-machine MVCC key-value store for discrete workshop scheduling,
with a JSON-driven CLI. Node.js 22, standard library only, tested with
`node:test`. No network access anywhere.

- Work orders are JSON values; a transaction reads work-order versions and
  writes the workcenter + time slot a work order occupies.
- Multi-version chains per key; a transaction's snapshot is fixed at `begin`.
- Snapshot isolation: a commit merges only when none of its written keys were
  changed by commits newer than its snapshot (otherwise `E_SNAPSHOT`).
- Secondary unique index on `(workcenter, timeSlot)`, checked atomically over
  the commit's key space: two committed work orders can never occupy the same
  workcenter in the same time slot (`E_UNIQUE`).
- Commits are appended to `<dir>/log.jsonl` and replayed on open.

## Library API

```js
import { Store, StoreError } from './index.js';

const store = Store.open('./data'); // or new Store() for in-memory
const tx = store.begin();           // snapshot fixed here
tx.get('wo-1');                     // -> value or undefined
tx.put('wo-1', { workcenter: 'cnc-1', timeSlot: '08:00', qty: 5 });
tx.put('wo-2', null);               // null deletes
tx.commit();                        // -> committed version; throws StoreError
                                    //    with code E_UNIQUE / E_SNAPSHOT
tx.abort();
```

Any value that is a plain object with string `workcenter` and `timeSlot`
fields participates in the unique index. Everything else (strings including
`""`, numbers, arrays, other objects) is stored but not indexed. Empty keys
(`""`) are valid. `get`/`put` return and store deep copies, so mutating a
fetched value never corrupts the store.

## CLI

```
node src/cli.js [--data <dir>]
```

Reads a JSON array of commands (or newline-delimited JSON commands) from
stdin and writes one canonical JSON result (recursively sorted keys, compact)
per command to stdout.

Commands:

```json
{"op":"begin","tx":"t1"}
{"op":"get","tx":"t1","key":"wo-1"}
{"op":"put","tx":"t1","key":"wo-1","value":{"workcenter":"cnc-1","timeSlot":"08:00"}}
{"op":"commit","tx":"t1"}
{"op":"abort","tx":"t1"}
```

Results look like `{"ok":true,"snapshot":0,"tx":"t1"}`,
`{"found":true,"ok":true,"value":{...}}`, `{"ok":true,"version":1}`, or
`{"code":"E_UNIQUE","message":"...","ok":false}`.

Exit codes:

- `0` — every command succeeded
- `1` — at least one unique/snapshot conflict (`E_UNIQUE` / `E_SNAPSHOT`);
  the script keeps running after a conflict
- `2` — usage error (bad JSON, unknown op/argument, unknown transaction, …);
  the script stops at the first usage error

On any non-zero exit, stderr carries one canonical JSON `{"code","message"}`
object describing the first error.

Example:

```
$ echo '[{"op":"begin","tx":"a"},{"op":"put","tx":"a","key":"wo1","value":{"workcenter":"w1","timeSlot":"t1"}},{"op":"commit","tx":"a"}]' | node src/cli.js --data ./data
{"ok":true,"snapshot":0,"tx":"a"}
{"ok":true}
{"ok":true,"version":1}
```

## Tests

```
node --test
```

Covers the three acceptance scenarios (concurrent unique-index conflicts,
snapshot stability and stale-write rejection, exhaustive history enumeration
against a naive copy-array reference implementation — 416,444 histories with
≤2 transactions and ≤4 operations), plus persistence across reopen and the
edge cases: empty key, zero-length work order, and same-value repeated writes.
See `RESULTS.md` for the recorded results.
