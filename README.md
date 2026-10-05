# wip-count

Offline WIP (work-in-progress) counting for handheld terminals. Node.js 22
standard library only (`node:test` for tests). No dependencies, no network.

Three terminals count offline; after merge the inventory must be non-negative,
differences explainable, and sessions resumable after a crash.

## Layout

```
src/
  errors.js    WipError + exit-code mapping (2 validation, 3 state, 10 verify)
  validate.js  barcode / quantity / id validation
  core.js      keyOf, applyOps (negative -> pending, fixpoint drain), op ordering
  store.js     on-disk layout + atomic writes (tmp + rename)
  session.js   begin / scan / adjust / undo / close
  recovery.js  resume (crash recovery)
  sync.js      bidirectional version-vector sync
  verify.js    ledger recomputation cross-check
bin/wip-count.js  CLI
```

Data directory per terminal (`--dir`, default `./wip-data` or `$WIP_DIR`):

```
state.json     ledger: {nodeId, vv, inventory, ops, pending, closedSessions}
cursor.json    {offset} processed byte offset into scan.log
scan.log       JSONL change-capture log, keyed by bin+item
sessions/      open sessions, written via <id>.json.tmp + rename
```

## Rules

- Barcodes: bin `A-01` style (`^[A-Z]-\d{2}$`), item `ITM-0001` style
  (`^[A-Z]{2,4}-\d{4,12}$`); quantities are integers; scan qty >= 1,
  adjust delta != 0.
- Negative inventory is forbidden locally (exit 2, `NEGATIVE_INVENTORY`).
- Writes to a closed session fail with `CLOSED` (exit 3).
- `undo` pops the last op and is only allowed while the session is open.
- Merge: integer deltas commute. A merged op that would drive stock negative
  is parked in `pending` (never a hard failure) and retried after every
  merge/resume until it applies or stays explainably pending.

## Crash recovery (`resume`)

1. Crash before scan hits `scan.log` -> event never existed; operator rescans.
2. Crash before session tmp rename -> stale `*.tmp` discarded; the event is
   replayed from `scan.log` starting at the cursor offset (idempotent by scanId).
3. Crash after ledger commit -> ledger kept; leftover session file is removed
   because its id is already in `closedSessions`.

## CLI

```
wip-count init   --dir D --node A
wip-count begin  --dir D --session S1 [--node A]
wip-count scan   --dir D --session S1 --bin A-01 --item ITM-0001 [--qty 2]
wip-count adjust --dir D --session S1 --bin A-01 --item ITM-0001 --delta -1
wip-count undo   --dir D --session S1
wip-count close  --dir D --session S1
wip-count sync   --dir D --peer OTHER_DIR
wip-count resume --dir D
wip-count verify --dir D
```

Success: JSON on stdout, exit 0. Errors: JSON on stderr
(`{"error":{"code","message"}}`) with exit codes:

- `2` validation/usage (`INVALID_BARCODE`, `INVALID_QTY`, `NEGATIVE_INVENTORY`, `USAGE`)
- `3` state conflicts (`CLOSED`, `SESSION_NOT_FOUND`, `SESSION_EXISTS`, `NOTHING_TO_UNDO`, `NOT_INITIALIZED`)
- `10` `VERIFY_MISMATCH` (recomputed ledger diverges from stored inventory)

## Tests

```
node --test
```

Covers: negative-inventory boundary, writes after close, the three crash
points, three-terminal convergence with pending resolution, CLI exit codes,
and exhaustive enumeration of all merge orders for n <= 8 concurrent ops
(40320 orders at n=8) asserting a single legal merge result.
