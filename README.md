# winsync

Simulates pulling records from read-only segment logs with a sliding
verification window and a crash-safe, resumable commit watermark.

## Segment format

Each `.seg` file in the source directory is a sequence of binary records:

```
[crc32: u32 big-endian][length: u32 big-endian][payload bytes]
```

`crc32` is `zlib.crc32(payload) & 0xFFFFFFFF`. Records are numbered with a
global `seq` across all `.seg` files in sorted filename order.

## Usage

```
python -m winsync pull SRC DST --win W --ack ACK
```

- `SRC`  — directory of `.seg` files (read-only source)
- `DST`  — destination JSONL file, one `{"seq", "segment", "payload"}` per line
- `--win W` — sliding window size (records verified concurrently, default 8)
- `--ack ACK` — ACK state file (JSON: `high_watermark`, `quarantined`)

stdout prints a JSON report `{"high_watermark": N, "quarantined": [...]}`;
errors go to stderr.

## Semantics

- Up to `W` records are CRC-verified concurrently (thread pool), but the
  commit watermark only advances contiguously, in `seq` order.
- Commits are crash-safe: each record is appended to DST and fsynced
  *before* the ACK file is updated (atomic tmp + rename). Recovery uses
  `max(ack.high_watermark, dst.max_seq + 1)`, so a crash between the two
  writes never duplicates records in DST.
- Duplicate or stale ACKs never move the watermark backwards or skip
  segments.
- On the first CRC failure the segment is marked `quarantined` and no
  further records commit; records already committed are kept. Quarantine
  state persists in the ACK file across restarts.

## Exit codes

- `0` — clean completion
- `2` — usage / IO error (message on stderr)
- `7` — one or more segments quarantined (e.g. first segment corrupt:
  DST stays empty)

## Tests

```
python -m unittest discover -s tests -v
```

Covers: randomized drop/duplicate/corrupt sources (n<=500) vs a serial
reference, crash injection between DST and ACK writes, W=1 vs W=8
equivalence, and first-segment-corrupt exit code 7. Real output is
recorded in `TEST_LOG.txt`.
