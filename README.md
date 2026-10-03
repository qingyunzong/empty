# pallet-transfer-db

Offline, single-node repository for QC batch transfers between pallets.
Node.js 22, standard library only, tests via `node:test`.

## Features

- Atomic multi-batch transfer: move several lots from a source pallet to a
  target pallet in one transaction, optionally setting the `quarantine` flag.
- MVCC version chain per `(palletId, lotId)` key (`cmin`/`cmax` commit
  timestamps) giving snapshot isolation to transactions.
- Write-ahead log (`wal.log`, JSON lines + SHA-256 checksum per record) with
  `begin` / `rec` / `commit` records. A transaction is durable and visible
  only once its commit marker is written.
- Unique secondary index on `(palletId, lotId)`, maintained on commit and
  rebuilt from the version chains during recovery.
- Snapshot validation at commit: the batch must still belong to the source
  pallet (otherwise `E_SNAPSHOT`) and the target pallet must not already hold
  the same `lotId` (otherwise `E_DUP`). The same `lotId` may exist on
  different pallets with independent state.

## Crash points and recovery

Commit order: `begin` + `rec` records -> **after_records** -> `commit` marker
-> **after_commit** -> in-memory apply.

- Crash at `after_records`: the transaction has no commit marker, so recovery
  drops its tentative records; source, target, quarantine flags and the index
  remain exactly as before the transfer.
- Crash at `after_commit`: the commit marker is durable, so recovery replays
  the transaction and all transfers become visible.
- Recovery replays committed transactions in commit-ts order, rebuilds the
  `(palletId, lotId)` index, and truncates a torn tail (partial last line).
  Any other malformed record or checksum mismatch is corruption (`E_CORRUPT`).

## Library

```js
const { Database } = require('./src/db');
const db = Database.open('/path/to/db');          // recovers on open
const t = db.begin();                              // snapshot taken here
t.transfer('P1', 'P2', ['L1', 'L2'], true);        // quarantine = true
t.commit();                                        // validates + WAL + apply
db.dump();                                         // { pallets: {...} }
db.dumpIndex();                                    // sorted index entries
```

Crash simulation for tests: `Database.open(dir, { crashAt: 'after_records' })`
or `'after_commit'`; `commit()` then throws `SimulatedCrash` (`E_CRASH`) at
the chosen point and the instance is dead — reopen to recover.

## CLI

```
node src/cli.js <dbDir> put      '{"pallet":"P1","lot":"L1","quarantine":true}'
node src/cli.js <dbDir> transfer '{"from":"P1","to":"P2","lots":["L1","L2"],"quarantine":false}'
node src/cli.js <dbDir> state
node src/cli.js <dbDir> index
```

- All input/output is JSON (one JSON document per stdout line).
- Exit codes: `0` success, `1` business error (`E_DUP`, `E_SNAPSHOT`,
  `E_NOT_FOUND`, `E_ARG`, `E_USAGE`), `2` corruption (`E_CORRUPT`),
  `70` simulated crash when `PALLET_CRASH_AT=after_records|after_commit` is
  set (recovery happens automatically on the next open).

## Tests

`node --test` (also `npm test`):

- `test/acceptance.test.js`
  - 3-batch transfer crashing at `after_records` / `after_commit`.
  - Concurrent transfer of the same batch to two pallets -> one commits, the
    other gets `E_SNAPSHOT`; duplicate `lotId` on target -> `E_DUP`.
  - Snapshot-isolation read stability + MVCC version chain checks.
  - Exhaustive enumeration of 6,174 transfer/crash histories (3 lots, 2
    pallets, history length 1-3, crash point none/`after_records`/
    `after_commit` per step) checked against a naive reference that only
    applies fully committed blocks; state and rebuilt index compared after
    every recovery and after a final clean restart.
- `test/cli.test.js`: JSON roundtrip, business errors exit 1, corrupted WAL
  exits 2, torn tail tolerated, crash simulation via `PALLET_CRASH_AT`.

### Recorded result (2026-10-03, node v22.22.1)

```
# tests 2
# pass 2
# fail 0
# duration_ms 80694.542562
```

(2 test files, 8 top-level tests, all passing; runtime is dominated by the
6,174-history enumeration and per-process CLI spawns.)
