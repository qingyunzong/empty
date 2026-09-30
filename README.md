# cdcsync

Apply a JSONL change-data-capture (CDC) log to a SQLite key/value table
with **exactly-once** semantics. Python 3.11+ standard library only.

## Usage

```
python -m cdcsync apply --log LOG.jsonl --db state.db --ckpt ckpt.json
```

Prints a JSON counter object to stdout, e.g.
`{"applied": 3, "duplicates": 0, "failed": 0, "pending": 0}`
(`pending` is the number of records still buffered in the pending table at
the end of the run). All errors go to stderr.

Exit codes: `0` ok, `1` I/O error, `3` corrupt log (invalid JSON or broken
hash chain; the DB stays at the last committed consistent point),
`4` injected fault (testing).

## Log format

One JSON object per line: `src, seq, op, key, value, ts, hash`.

- `op`: `put`/`set`/`upsert`, or `del`/`delete`/`remove`. Unknown ops are
  consumed and counted as `failed`.
- `hash`: hash chain over the file,
  `hash[i] = sha256(hash[i-1] + "\n" + canonical_json(payload))` with
  `hash[0]` computed over `"0"*64` (GENESIS); `payload` is the record
  without `hash`, serialized with sorted keys and compact separators.
  `cdcsync.loggen.write_log` builds valid logs.

## Semantics

1. Per `src`, `seq` starts at 1 and must be contiguous. Records ahead of
   the checkpoint are buffered in the `pending` table and never applied
   out of order; filling a gap cascades the buffered records.
2. Records with `seq < next_seq` (duplicates/old) are idempotently
   skipped; the first occurrence of a `(src, seq)` wins.
3. The checkpoint lives in the same SQLite database as the KV table; the
   KV write and the checkpoint update commit in **one transaction**, so a
   crash between "DB write" and "ckpt write" simply rolls back and the
   record is replayed exactly once after restart. `--ckpt CK` is an
   atomically written JSON mirror of the checkpoint table (imported only
   when the DB checkpoint table is empty).
4. Invalid JSON or a broken hash chain aborts with exit code 3; everything
   committed before the bad line stays.
5. Each key carries a `(vsrc, vseq)` version (deletes are tombstones) and
   an event only overwrites a key when its `(src, seq)` is newer, so the
   final state equals replaying all records sorted by `(src, seq)`.

## Fault injection (testing)

`CDCSYNC_FAULT_AFTER=N python -m cdcsync apply ...` raises
`cdcsync.FaultInject` after the N-th KV write, before the checkpoint
write, inside the same transaction — simulating a crash at the hardest
point. Re-run without the variable to recover.

## Tests

```
python -m unittest discover -s tests -v
```

Covers: (A) random 200-event log with duplicates/out-of-order vs. an
independent model, plus exhaustive permutations for small n (n <= 7);
(B) `FaultInject` between DB write and ckpt write, restart correctness;
(C) seq gap pending/fill; (D) corrupt line -> exit 3, checkpoint frozen.
Real output is recorded in `TEST_LOG.txt`.
