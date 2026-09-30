# cdcsync

Apply JSONL change-data-capture logs to a SQLite key/value table with
exactly-once semantics. Python 3.11+ standard library only.

## Usage

```sh
python -m cdcsync apply --log LOG.jsonl --db main.db --ckpt ckpt.db
python -m cdcsync dump  --db main.db
```

`apply` prints a counts JSON object to stdout, e.g.
`{"applied": 3, "pending": 0, "failed": 0, "ignored": 1}`.
All errors go to stderr.

Exit codes: `0` success, `1` injected fault (`FaultInject`), `2` other
errors, `3` invalid log (bad JSON / bad schema / broken hash chain) — on
exit 3 the DB and checkpoint are left untouched at the last consistent
point.

## Log format

One JSON object per line: `src`, `seq` (int >= 1), `op` (`put`/`del`),
`key`, `value` (any JSON), `ts` (number), `hash` (64 hex chars).

The `hash` chains each event to its predecessor in the canonical
`(src, seq)` total order:
`hash = sha256(prev_hash + canonical_json(event_without_hash))`, with
`prev_hash = "0"*64` for the first event. Because the chain follows the
sorted order rather than file order, log lines may be shuffled and
duplicated freely. `cdcsync.chain_events()` stamps hashes for you.

## Semantics

1. Per `src`, `seq` must be contiguous. Events ahead of a gap are parked
   in a persistent `pending` table and never applied past the gap; a
   later run that supplies the missing seq drains them automatically.
2. `seq <=` the checkpointed watermark (and duplicate lines) are
   idempotently ignored.
3. KV mutations, pending-table maintenance and checkpoint updates commit
   in **one SQLite transaction** spanning both files (the ckpt DB is
   `ATTACH`ed; rollback-journal mode gives atomic multi-file commit). A
   crash after the KV writes but before the ckpt writes rolls everything
   back, so a restart replays the log without any effect applying twice.
4. Any bad JSON line or hash-chain mismatch aborts the run with exit
   code 3 before the DB is opened for writing.
5. Within a run, applicable events are replayed in the `(src, seq)`
   total order, so the final state equals an ordered replay of the log.

## Fault injection

Set `CDCSYNC_FAULT_AFTER_APPLY=1` to raise `cdcsync.FaultInject` at the
crash point between the apply phase and the checkpoint phase (used by
the tests to prove exactly-once recovery).

## Tests

```sh
python -m unittest discover -s tests -v
```

Covers: (A) 200 random events with duplicates/disorder vs an independent
reference replay, plus exhaustive permutations of a 7-line log;
(B) fault injection between apply and ckpt with restart;
(C) seq gap -> pending, then backfill; (D) bad JSON / tampered hash ->
exit 3 with the checkpoint unmoved. Real output is kept in TEST_LOG.txt.
