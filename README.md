# snapsync

Compress an operation log into generational snapshots and restore state,
with strict snapshot/log generation consistency. Python 3.11+ standard
library only.

## Usage

```sh
python -m snapsync compact LOG SNAP --keep K
python -m snapsync restore LOG SNAP
```

- `compact` verifies `SNAP` against `LOG`, folds the whole log into a new
  snapshot generation, rotates generations (`SNAP` -> `SNAP.1` -> ...),
  keeps the most recent `K` (values `< 1` are treated as `1`, so the
  current valid snapshot is never deleted), and truncates the log.
  Prints `{"kept": N, "truncated": N, "restored_hash": "<hex>"}` on stdout.
- `restore` rebuilds the state hash from the snapshot plus the log suffix
  and prints `{"restored_hash": "<hex>"}`.

Errors go to stderr. Exit codes: `0` ok, `2` log/IO/usage error,
`8` corrupt or generation-mismatched snapshot (the log is never modified
in that case, and the tool never falls back to an older generation).

## Formats

Log (JSON Lines): `{"term":1,"seq":1,"op":"set x=1","crc":3914851494}`
where `crc` is `zlib.crc32` of the canonical JSON of `{term,seq,op}`.
Sequences are contiguous and terms non-decreasing.

Snapshot (JSON): `{"version":1,"last_term":1,"last_seq":3,"state_hash":"..."}`
where `state_hash` is a chain hash over the covered operations.

## Consistency rules

Truncation happens only when the snapshot's `(last_term, last_seq)`
matches a prefix boundary of the log and every entry's crc verifies.
When the log still contains the full history from seq 1, the snapshot's
`state_hash` is recomputed from genesis and compared, so tampering is
detected (exit 8). Restore from a valid snapshot plus its log suffix is
guaranteed to equal a full replay from genesis.

## Tests

```sh
python -m unittest discover -s tests -v
```

See `TEST_LOG.txt` for a recorded run.
