# wip-count

Offline WIP (work-in-progress) counting for handheld terminals. Node.js 22
standard library only; tests use `node:test`. No dependencies, no network.

Three terminals count offline, then converge by pairwise sync. Guarantees:

- merged stock never goes negative (violating deltas are deferred to a
  `pending` queue with an explanation instead of failing);
- every difference is explainable (`history` + per-node deltas + `pending`
  reasons);
- sessions resume after crashes at any of the three write-boundary fault
  points.

## Layout

```
bin/wip-count.js   CLI: begin | scan | sync | resume | close | verify
src/validate.js    barcode / quantity / id validation
src/storage.js     fsync'd WAL append, atomic tmp+rename writes, tmp discard
src/ledger.js      convergent ledger: version vectors, merge, pending, verify
src/store.js       sessions (begin/scan/adjust/undo/close), cursor, recovery
test/              node:test suites
```

## Data directory

```
<dir>/node.json          terminal identity (created once)
<dir>/scanlog.jsonl      write-ahead log, one JSON op per line (seq per session)
<dir>/cursor.json        processed WAL offset per session
<dir>/sessions/<id>.json session snapshot (atomic tmp+rename)
<dir>/ledger.json        committed, convergent ledger
```

## Sessions

`begin -> scan | adjust | undo -> close`. Change capture is keyed by
`bin|item`. Validation:

- item barcode: `^[A-Z]{2,5}-\d{3,10}$` (e.g. `WIP-0001`)
- bin barcode: `^[A-Z]-\d{2}$` (e.g. `A-01`)
- scan qty: positive integer; adjust delta: non-zero integer
- closing a session that would drive any key below 0 fails with
  `NEGATIVE_INVENTORY` and the session stays open
- any write to a closed session fails with `CLOSED`; `undo` on a closed
  session fails with `UNDO_CLOSED`

## Crash recovery

Write order per op: WAL append (fsync) -> session tmp+rename -> cursor.
`resume` (also run automatically before every CLI command) handles the three
fault points:

1. **crash before scan persisted** — nothing on disk; the scan is lost and
   must be rescanned;
2. **crash before session tmp rename** — the stale `*.tmp` is discarded and
   the WAL entry is replayed exactly once from the cursor offset;
3. **crash after ledger commit** — the ledger is kept; the session is
   finalized as closed without re-applying (idempotent via
   `appliedSessions`).

Fault injection for tests: `Store.open(dir, { faults: [...] })` with
`beforeScanAppend`, `beforeSessionRename`, `afterLedgerCommit` (arm-once,
throws `CrashError`).

## Sync & convergence

Each key holds at most one delta entry per node, tagged with the node's
version-vector sequence. Merge unions entries (max seq per node), version
vectors (componentwise max), applied-session sets and history. Concurrent
adjusts on the same item from different nodes commute. If a merged key would
go negative, negative contributors are evicted to `pending` (largest node id
first — a pure function of the entry set, so all orders converge) and retried
whenever stock allows. `sync` writes the merged ledger to both directories
(bidirectional). `verify` recomputes stock, checks non-negativity, version
vector/history consistency and pending applicability; with `--peer` it also
checks convergence.

## CLI

```
wip-count begin  --data DIR --session S [--node ID]
wip-count scan   --data DIR --session S --bin A-01 --item WIP-0001 --qty 3
wip-count sync   --data DIR --peer DIR
wip-count resume --data DIR
wip-count close  --data DIR --session S
wip-count verify --data DIR [--peer DIR]
```

stdout is a JSON result. Errors are JSON on stderr
(`{"error":{"code","message"}}`) with exit codes:

- `2` usage / validation (`USAGE`, `VALIDATION`)
- `3` state conflicts (`CLOSED`, `NEGATIVE_INVENTORY`, `NOT_FOUND`,
  `SESSION_EXISTS`, `UNDO_CLOSED`, ...)
- `10` verify failure (inconsistency or divergence)
- `1` unexpected internal error

## Tests

```
node --test
```

Covers: negative-inventory boundary (exact zero closes, one below fails),
writes after close (`CLOSED`), the three fault points, undo rules, and an
exhaustive enumeration of all merge orders for n <= 8 concurrent nodes
asserting a single legal merge result. See `RESULTS.md` for the recorded run.
