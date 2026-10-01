# RESULTS

All commands were actually executed in this workspace; outputs below are
the real recorded results.

## Unit tests

Command (run from the repository root):

    python3.11 -m unittest discover -s tests -v

Environment: Python 3.11 (`/home/delin/.local/bin/python3.11`),
Linux x86_64, 2026-10-01.

Result (tail of the real output):

    test_all_zero_1mib_cuts_only_at_max ... ok
    test_buffer_size_independence ... ok
    test_empty_input ... ok
    test_forced_cut_tie_and_precedence ... ok
    test_locate_and_verify_after_one_byte_change ... ok
    test_locate_out_of_range ... ok
    test_reference_comparison_up_to_3000 ... ok
    test_chunk_locate_verify_roundtrip ... ok
    test_first_bad_chunk_reports_min_offset ... ok
    test_gap_is_corrupt ... ok
    test_overlap_is_corrupt ... ok
    test_roundtrip_and_verify ... ok
    test_size_mismatch_is_corrupt ... ok
    test_unsorted_is_corrupt ... ok

    ----------------------------------------------------------------------
    Ran 14 tests in 54.242s

    OK

Counts: **14 tests run, 14 passed, 0 failed, 0 errors** (exit code 0).

## CLI smoke test (real run)

    python3.11 -m rchunk chunk demo.bin demo.bin.chunk
    # wrote demo.bin.chunk: 31 chunks, 100000 bytes

    python3.11 -m rchunk verify demo.bin demo.bin.chunk
    # OK: 31 chunks verified            (exit 0)

    python3.11 -m rchunk locate demo.bin.chunk 50000
    # offset=47550 len=4096 sha256=d517ff0575575e4e46b88053ba64ca3b2dfa9cdd99f67d9af3c0b85094083b20

    # after flipping one byte at offset 50000:
    python3.11 -m rchunk verify demo.bin demo.bin.chunk
    # Corrupt: sha256 mismatch at offset 47550   (exit 1)

## Acceptance mapping

- All-zero 1 MiB: cut only at the 4096 hard limit (256 equal chunks) —
  `test_all_zero_1mib_cuts_only_at_max`.
- Same random stream fed with 8 / 4096 / 65536-byte buffers yields
  identical chunk lists — `test_buffer_size_independence`.
- One-byte change: `locate` returns the minimal covering chunk and
  `verify` reports that chunk's offset — `test_locate_and_verify_after_one_byte_change`,
  `test_first_bad_chunk_reports_min_offset`, CLI smoke test.
- Lengths 0..3000 cross-checked byte-for-byte against an independent
  one-shot reference that simulates the rolling state —
  `test_reference_comparison_up_to_3000` (3 datasets x 3001 lengths).
- Forced-cut tie: fingerprint hit exactly at len 4096 cuts there;
  hit at 4095 wins over the limit (first condition reached decides) —
  `test_forced_cut_tie_and_precedence`.
- Index must be ascending and contiguous; any gap/overlap is Corrupt —
  `test_gap_is_corrupt`, `test_overlap_is_corrupt`,
  `test_unsorted_is_corrupt`, `test_size_mismatch_is_corrupt`.
