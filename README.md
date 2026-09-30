# snapsync

Snapshot-based compaction of an operation log, with a consistency check that
refuses to truncate against a snapshot that does not provably match a log
prefix (no silent fallback to a stale generation).

## Formats

- Log (JSONL): `{"term": int, "seq": int, "op": str, "crc": int}` where
  `crc = crc32("term|seq|op")`. Seqs are consecutive, terms non-decreasing.
- Snapshot (JSON): `{"last_term": int, "last_seq": int, "state_hash": hex}`.
  `state_hash` is the SHA-256 hash chain after replaying the log prefix
  through `last_seq`.

## CLI

    python -m snapsync compact LOG SNAP --keep K

Truncates `LOG` to the entries after the snapshot's `(last_term, last_seq)`
and keeps the `K` most recent snapshots (the current `SNAP` counts as one;
`--keep 0` is treated as 1; the current snapshot is never deleted). Older
generations live next to `SNAP` as `SNAP.<last_seq>` and are created by
`snapsync.write_snapshot`.

stdout (success): JSON with `kept`, `truncated`, `restored_hash`,
`snapshots_kept`. Errors go to stderr.

Exit codes: `0` ok, `2` usage/IO error, `3` log integrity failure,
`8` snapshot missing/corrupt/inconsistent (log left untouched).

## Semantics

1. Truncation is allowed only if the snapshot's `(last_term, last_seq)`
   matches a log prefix, every log entry's crc verifies, and replaying the
   prefix reproduces `state_hash`.
2. Restore = replay the post-snapshot log suffix on top of the snapshot's
   `state_hash`; by construction this equals a full replay from genesis.
3. Writes are atomic (temp file + rename); on any validation failure the log
   is left byte-identical.

## Tests

    python -m unittest discover -s tests -v
