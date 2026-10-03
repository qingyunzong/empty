# quota-freeze

Offline multi-account quota freezing library and CLI. Node.js 22, standard
library only, tests use `node:test`.

## Layout

- `src/index.js` — `QuotaEngine`: transactions, MVCC snapshots, freeze
  commit validation, (priority, account) secondary index, crash recovery.
- `src/lock-manager.js` — per-account locks, waits-for graph, elementary
  cycle enumeration, smallest-txn-id victim selection, configurable lock
  timeout (default 200ms).
- `src/wal.js` — append-only WAL with `INIT`/`PREPARE`/`COMMIT`/`ABORT`
  records and replay-based recovery.
- `src/cli.js` — `freeze`, `cancel`, `query`, `crash --prepared` commands.

## Semantics

- A transaction freezes several accounts in one commit; locks are acquired
  per account and released at commit/abort (or immediately on `unfreeze`).
- Readers see stable MVCC snapshots (`dataVersions`), but freeze validation
  at commit time always uses the latest committed balances.
- Deadlocks: the waits-for digraph is checked before every wait; elementary
  cycles are enumerated (small graphs) and the transaction with the smallest
  id in the cycle is aborted with `E_DEADLOCK`. Waits longer than
  `lockTimeoutMs` (default 200, configurable for tests) fail with
  `E_LOCK_TIMEOUT`.
- Freezes are journaled as `PREPARE` then `COMMIT`. After a crash, any
  `PREPARE` without a matching `COMMIT` is dropped, so uncommitted freezes
  never take effect and the lock table starts empty.

## CLI

```sh
node src/cli.js init   --wal q.wal --account A --balance 500 --priority 1
node src/cli.js freeze --wal q.wal A:100 B:50        # begin+freeze+commit
node src/cli.js freeze --wal q.wal A:200 --prepared  # PREPARE only
node src/cli.js crash  --wal q.wal --prepared        # simulate crash
node src/cli.js query  --wal q.wal --account A
node src/cli.js query  --wal q.wal                   # all accounts + scan
node src/cli.js cancel --wal q.wal --txn T2
```

## Tests

```sh
node --test
```
