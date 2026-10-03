# freeze-db

Offline multi-account quota freeze library + CLI. Node.js 22, standard library
only, tests via `node:test`.

## Design

- **Transactions** (`Database.transaction(fn)`): one transaction may freeze
  several accounts; locks are acquired **per account** (exclusive) by
  `src/lockmanager.js`.
- **MVCC**: every commit appends a new versioned `{balance, frozen}` record per
  touched account; `tx.getAvailable()` reads the snapshot taken at transaction
  begin. **Freeze validation always uses the latest committed state**
  (`tx.freeze` checks `_latest`), never the snapshot.
- **Deadlocks**: waiting transactions form a directed wait-for graph (edge
  `T -> H` when `T` waits for a lock held by `H`). `src/waitgraph.js`
  enumerates all elementary cycles (small-scale reference implementation).
  When a cycle appears, the transaction with the **smallest transaction id**
  is aborted with `E_DEADLOCK`.
- **Timeouts**: any lock wait longer than `lockTimeoutMs` (default **200 ms**,
  configurable via `new Database({ lockTimeoutMs })`) fails with
  `E_LOCK_TIMEOUT`.
- **Cancel**: `tx.cancel(freezeId)` releases a freeze inside a transaction;
  the release takes effect on commit.
- **(priority, account) index**: active freezes are kept in a sorted secondary
  index and scanned in freeze-priority order via `scanByPriority()`.
- **WAL**: every commit appends `PREPARE` (with the transaction's freezes and
  cancels), applies the changes, then appends `COMMIT` and writes a snapshot.
  On recovery, only `PREPARE` records with a matching `COMMIT` are replayed;
  any `PREPARE` without `COMMIT` never takes effect, and the (in-memory) lock
  table is empty after restart.

## CLI

```sh
node cli.js freeze <account> <amount> [--priority N] [--db DIR]
node cli.js cancel <freezeId> [--db DIR]
node cli.js query [account] [--db DIR]
node cli.js crash --prepared --account A --amount N [--priority P] [--db DIR]
```

`crash --prepared` writes a `PREPARE` record and exits with code 2 **without**
writing `COMMIT`, simulating a crash. The next `query` shows the account
available balance unchanged, and a fresh `freeze` succeeds.

## Tests

```sh
node --test
```

- `test/deadlock.test.js` — two transactions freeze A/B in opposite order;
  deterministic gated interleavings plus randomized ones; exactly one success
  and one `E_DEADLOCK`, victim is the smallest txid, no permanent wait.
- `test/timeout.test.js` — lock holder sleeps; a third party waiting on the
  same account gets `E_LOCK_TIMEOUT` after the configured timeout.
- `test/crash.test.js` — `crash --prepared` via the CLI; after the crash the
  available balance is unchanged and a fresh freeze succeeds.
- `test/waitgraph.test.js` — reference cycle enumeration on small graphs.
- `test/mvcc.test.js` — snapshot reads vs. latest-committed validation.
- `test/index.test.js` — `(priority, account)` index scan and cancel.
