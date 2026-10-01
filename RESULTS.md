# RESULTS

Environment: Python 3.14.4 (code targets the Python 3.11 standard library
only), Linux, repo root as CWD.

## Test suite

Command:

    python3 -m unittest discover -s tests -v

Result (real run):

    test_build_then_full_verify (test_midx.TestFullVerify4MiB.test_build_then_full_verify) ... ok
    test_bad_magic_exit_4 (test_midx.TestIndexCorruption.test_bad_magic_exit_4) ... ok
    test_crc_mismatch_exit_4 (test_midx.TestIndexCorruption.test_crc_mismatch_exit_4) ... ok
    test_truncated_last_byte_exit_4 (test_midx.TestIndexCorruption.test_truncated_last_byte_exit_4) ... ok
    test_tail_block_hashed_by_actual_length (test_midx.TestLocalReadsOnly.test_tail_block_hashed_by_actual_length) ... ok
    test_verify_range_reads_only_covered_blocks (test_midx.TestLocalReadsOnly.test_verify_range_reads_only_covered_blocks) ... ok
    test_corrupt_block_17_local_verify (test_midx.TestLocalVerifyFindsBlock17.test_corrupt_block_17_local_verify) ... ok
    test_first_bad_block_is_smallest (test_midx.TestLocalVerifyFindsBlock17.test_first_bad_block_is_smallest) ... ok
    test_cli_root_matches_reference (test_midx.TestReferenceTreeLeafCounts.test_cli_root_matches_reference) ... ok
    test_leaf_counts_1_to_40_against_brute_force (test_midx.TestReferenceTreeLeafCounts.test_leaf_counts_1_to_40_against_brute_force) ... ok

    ----------------------------------------------------------------------
    Ran 10 tests in 13.914s

    OK

Counts: 10 tests ran, 10 passed, 0 failed, 0 errors.
Coverage of the acceptance criteria:

- 4 MiB random file: build + full `verify` -> exit 0 (`TestFullVerify4MiB`).
- One byte flipped in block 17: local `verify --offset --length` reports
  `first bad block 17`, exit 1 (`TestLocalVerifyFindsBlock17`).
- Index truncated by its last byte: `verify` and `root` exit 4
  (`TestIndexCorruption.test_truncated_last_byte_exit_4`).
- Leaf counts 1..40 checked against an independent brute-force sha256
  tree (all levels + root + every leaf path)
  (`TestReferenceTreeLeafCounts`).
- Locality proven by a tracking file object: a 3-block verify reads
  exactly 3 blocks, never the whole file (`TestLocalReadsOnly`).

## Manual end-to-end acceptance run (real commands, /tmp/midx_demo)

    python3 -m midx build f.bin --block-size 65536
    # built f.bin.index: blocks=64 block_size=65536 file_size=4194304 root=bb9535a4...80dda6f
    python3 -m midx verify f.bin            -> exit 0  (OK: blocks 0..63 verified)
    python3 -m midx root f.bin              -> exit 0  (bb9535a4...80dda6f)
    # flip one byte at offset 17*65536+7
    python3 -m midx verify f.bin --offset 1048576 --length 196608
    #   -> exit 1  "BAD: first bad block 17 (offset 1114112); bad blocks (1): 17"
    python3 -m midx verify f.bin            -> exit 1  (same first bad block 17)
    truncate -s -1 f.bin.index
    python3 -m midx verify f.bin            -> exit 4  (index error: root truncated or trailing garbage)
    python3 -m midx root f.bin              -> exit 4  (index error: root truncated or trailing garbage)
