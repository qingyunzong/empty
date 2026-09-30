# winsync

Pull records from a read-only segment log into a JSONL destination with
a sliding validation window, quarantine of corrupt segments, and
exactly-once recovery via an ACK watermark file. Python 3.11+ standard
library only.

## Usage

```
python -m winsync pull SRC DST --win W --ack ACK
```

- `SRC`: directory of `.seg` files. A file name is `<seq>.seg` or
  `<seq>.<tag>.seg` (duplicate delivery of the same segment). File
  content: 8 lowercase hex chars of `crc32(payload)`, then `\n`, then
  the UTF-8 payload.
- `DST`: JSONL output, one `{"seq": N, "payload": "..."}` per line.
- `--win W`: sliding window bounding concurrent CRC validation. Commit
  decisions are made in strict sequence order, so results are identical
  for any `W`.
- `--ack ACK`: JSON watermark file `{"high_watermark": N}`, written
  atomically; used to resume after restarts.

stdout prints a JSON summary with `high_watermark`, `quarantined`,
`committed`, `resumed_from`, `dst`. Errors go to stderr.

## Semantics

- The commit watermark only advances across a contiguous run of present,
  valid segments; it never regresses and never skips a segment, so
  duplicate ACKs are harmless.
- A segment failing CRC validation is quarantined and reported in
  `quarantined`; commits after it stop, earlier commits are kept.
- On restart, DST is reconciled with the ACK watermark: lines beyond the
  watermark (crash after the DST write, before the ACK write) are
  truncated, so committed records never re-enter DST.

## Exit codes

- `0`: success (no quarantined segments).
- `7`: one or more segments quarantined; commit halted.
- `1`: fatal error (bad arguments, unreadable source, invalid ACK file).

## Fault injection

Setting the environment variable `WINSYNC_CRASH_AFTER_DST=1` makes the
process crash (`os._exit(1)`) after the DST write but before the ACK
write, to exercise crash recovery.

## Tests

```
python -m unittest discover -s tests -v
```

Latest real run output is recorded in `TEST_LOG.txt`.
