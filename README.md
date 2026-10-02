# mvcc-event-store

Single-node, offline device-event store with MVCC version chains, snapshot
isolation, tombstone deletes and secondary indexes. Node.js 22, standard
library only (`node:test` for tests), no dependencies.

## Model

- `eventId` identifies the business event.
- `validAt` is when the event actually happened (device time; epoch-ms number
  or ISO-8601 string, stored as epoch ms).
- `txAt` is the store's logical commit clock (one tick per committed write).

Events may arrive out of order and may be corrected. Every write
(`create` / `correct` / `delete`) auto-commits as its own transaction and
**appends** a new version to the event's chain — corrections never overwrite
history, and deletes append a tombstone version. A snapshot captures the
commit clock at its begin and always reads the latest committed version with
`txAt <= begin`.

Secondary indexes:

- `(eventId)` — version-chain lookup.
- `(deviceId, validAt)` — sorted index with one entry per committed live
  version. A correction that moves `validAt` (or `deviceId`) migrates the
  index by adding a new entry; old entries stay so old snapshots keep a
  consistent view. Range scans resolve MVCC visibility per candidate. No
  vacuum/GC is performed.

Errors: `E_DUP` (create of a live `eventId`), `E_NOTFOUND` (correct/delete of
a missing or deleted `eventId`), `E_INVALID` (bad input). Re-creating a
deleted `eventId` is allowed (tombstone semantics). Empty ranges return `[]`.

## Library

```js
import { EventStore } from './src/store.js';

const store = new EventStore();
store.create({ eventId: 'A', deviceId: 'pump-1', validAt: '2026-01-01T00:00:00Z', data: { status: 'alarm' } });
const s1 = store.snapshot();
store.correct({ eventId: 'A', data: { status: 'reset' } }); // omitted fields inherit
const s2 = store.snapshot();

s1.get('A');                    // { ..., data: { status: 'alarm' } }
s2.get('A');                    // { ..., data: { status: 'reset' } }
s1.range('pump-1', 0, Date.now()); // alarm version
store.delete('A');              // tombstone; s1 still reads history
```

## CLI

Reads a JSON command object or array from a file argument or stdin, executes
against one in-memory store, prints one JSON result per command:

```sh
echo '[{"op":"create","eventId":"A","deviceId":"d1","validAt":1000,"data":{"status":"alarm"}},
       {"op":"snapshot"},
       {"op":"correct","eventId":"A","data":{"status":"reset"}},
       {"op":"get","eventId":"A","snapshot":"snap-1"},
       {"op":"range","deviceId":"d1","from":0,"to":2000}]' | node src/cli.js
node src/cli.js commands.json
```

Commands: `create` / `correct` / `delete` / `snapshot` / `get` / `range`.
`snapshot` returns a handle (`snap-1`, ...) usable as `"snapshot"` in `get`
and `range`; without it they read the latest state. `from`/`to` are inclusive
and may be omitted for an open bound.

Exit codes:

- `0` — every command succeeded
- `1` — at least one command failed with a store error (`E_DUP` / `E_NOTFOUND` / `E_INVALID`); remaining commands still run
- `2` — usage error (unreadable input, invalid JSON, unknown op, unknown snapshot)

## Tests

```sh
node --test
```

Includes acceptance tests (correction visibility across snapshots, tombstone
deletes, `E_DUP`, `validAt` index migration, empty ranges) and a property
test that enumerates **all permutations** of insert/correct/delete orders for
1, 2 and 3 events (up to 9! = 362880 orders, parallelized across worker
threads) and checks every snapshot against a naive reference model: a plain
version array sorted by `txAt` plus snapshot filtering.
