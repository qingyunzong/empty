# Test Results

## Command

```
python3.11 -m unittest discover -s tests -v
```

(run from the repository root)

## Environment

- Python 3.11.16 (`/home/delin/.local/bin/python3.11`)
- Linux x86_64
- Date (UTC): 2026-10-01T03:59:20Z

## Counts

- Tests run: **32**
- Passed: **32**
- Failures: **0**
- Errors: **0**
- Wall time: 48.866s
- Final status: **OK**

## Tail of actual output

```
test_verify_ok (test_index.TestVerify.test_verify_ok) ... ok

----------------------------------------------------------------------
Ran 32 tests in 48.866s

OK
```

## Coverage of acceptance criteria

- `test_all_zero_1mib_cuts_only_at_max` — 1 MiB of zeros splits into
  exactly 256 chunks of 4096 bytes (forced cuts only).
- `test_buffer_size_independence` — random data chunked with 8, 4096
  and 65536-byte buffers yields identical chunk lists and identical
  serialized `.chunk` indexes.
- `test_locate_is_minimal_covering_chunk` (plus CLI flip test) — after
  flipping one byte, `locate` returns the smallest chunk covering it and
  `verify` blames that chunk's offset.
- `test_matches_reference_up_to_3000` — for every length 0..3000 the
  streaming chunker (buffers 8 and 4096) matches the one-shot
  byte-by-byte reference simulation.
- `test_forced_cut_tie_takes_limit` — crafted input where the
  fingerprint fires exactly on the byte reaching the 4096 limit; the
  forced cut is taken and both implementations agree.
- `test_first_bad_chunk_reports_minimal_offset` — with two corrupted
  chunks, `verify` reports the smaller offset.
