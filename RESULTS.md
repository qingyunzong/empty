# RESULTS

Command: `python -m unittest discover -v`

Date: 2026-10-01 11:56:01 CST

Python: Python 3.14.4

Exit code: 0

```
test_cold_start_empty_dir (tests.test_walwin.WalwinTestCase.test_cold_start_empty_dir) ... ok
test_crc_bad_tail_truncated (tests.test_walwin.WalwinTestCase.test_crc_bad_tail_truncated) ... ok
test_duplicate_seq_idempotent (tests.test_walwin.WalwinTestCase.test_duplicate_seq_idempotent) ... ok
test_fault_points_p1_to_p4 (tests.test_walwin.WalwinTestCase.test_fault_points_p1_to_p4) ... ok
test_p4_does_not_double_count_on_resend (tests.test_walwin.WalwinTestCase.test_p4_does_not_double_count_on_resend) ... ok
test_pending_gap_not_unsatisfiable (tests.test_walwin.WalwinTestCase.test_pending_gap_not_unsatisfiable) ... ok
test_unwritable_state_dir_exit3 (tests.test_walwin.WalwinTestCase.test_unwritable_state_dir_exit3) ... ok

----------------------------------------------------------------------
Ran 7 tests in 5.476s

OK
```
