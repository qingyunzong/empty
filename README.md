# minidb

A tiny WAL-backed transactional store (Python 3.11 standard library only).

The state directory maintains base tables `R(A, K)` and `S(K, B)` plus a
materialized join-count view grouped by `A`:

    view[a] = |{(r, s) : r in R, s in S, r.K = s.K, r.A = a}|

## Usage

    python3 minidb.py apply tx.json --state-dir db [--fail pre_commit|post_commit|post_checkpoint]
    python3 minidb.py recover --state-dir db

`tx.json` format:

    {"ops": [{"op": "insert", "table": "R", "tuple": ["a1", "k1"]},
             {"op": "delete", "table": "S", "tuple": ["k1", "b1"]}]}

Exit codes: `0` success, `2` semantic error (duplicate/missing tuple, unknown
table/op — no COMMIT record is written), `137` simulated crash.

## Design

- **WAL** (`wal.log`): JSON-lines `begin`/`op`/`commit` records, each carrying
  a monotonic `lsn`. Every record is fsynced before the operation proceeds.
- **Checkpoint** (`state.json`): base tables + view + `last_lsn`, written to a
  temp file, fsynced, atomically renamed, directory fsynced; then the WAL is
  truncated (fsynced).
- **Failure points**: `pre_commit` crashes before the COMMIT record;
  `post_commit` after COMMIT is fsynced but before checkpoint;
  `post_checkpoint` after the checkpoint is durable.
- **Recover**: replays the WAL, redoes only transactions whose COMMIT record
  exists and whose commit LSN is newer than the checkpoint's `last_lsn`
  (so a committed-and-checkpointed txn is never re-applied), then checkpoints.
  Transactions without a COMMIT record are discarded — fully rolled back.

## Tests

    python3.11 -m unittest test_minidb -v

Tests run the real CLI in subprocesses and verify the stored view against an
independent nested-loop recomputation from the committed base tables.
