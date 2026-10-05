# Test Results

Command: `python -m unittest discover -v`
Date: 2026-10-05 05:40:38 UTC
Python: Python 3.14.4

**Exit code: 0 (all 17 tests passed)**

```
test_cli_bad_json_exit2 (tests.test_latefix.TestCli.test_cli_bad_json_exit2) ... ok
test_cli_happy_path (tests.test_latefix.TestCli.test_cli_happy_path) ... ok
test_cli_missing_file_exit2 (tests.test_latefix.TestCli.test_cli_missing_file_exit2) ... ok
test_cli_non_numeric_val_exit2 (tests.test_latefix.TestCli.test_cli_non_numeric_val_exit2) ... ok
test_duplicate_before_and_after_finalize (tests.test_latefix.TestIdempotency.test_duplicate_before_and_after_finalize) ... ok
test_same_ts_different_val_not_duplicate (tests.test_latefix.TestIdempotency.test_same_ts_different_val_not_duplicate) ... ok
test_exact_boundary_corrects (tests.test_latefix.TestLatenessBoundary.test_exact_boundary_corrects) ... ok
test_first_event_beyond_horizon_dropped (tests.test_latefix.TestLatenessBoundary.test_first_event_beyond_horizon_dropped) ... ok
test_one_past_boundary_dropped (tests.test_latefix.TestLatenessBoundary.test_one_past_boundary_dropped) ... ok
test_random_small_inputs (tests.test_latefix.TestReferenceFuzz.test_random_small_inputs) ... ok
test_clock_regression_ignored_not_error (tests.test_latefix.TestValidation.test_clock_regression_ignored_not_error) ... ok
test_missing_fields_rejected (tests.test_latefix.TestValidation.test_missing_fields_rejected) ... ok
test_non_numeric_val_rejected (tests.test_latefix.TestValidation.test_non_numeric_val_rejected) ... ok
test_two_corrections (tests.test_latefix.TestVersionChain.test_two_corrections) ... ok
test_empty_windows_never_emit (tests.test_latefix.TestWatermarkAndEmpty.test_empty_windows_never_emit) ... ok
test_multiple_keys_independent (tests.test_latefix.TestWatermarkAndEmpty.test_multiple_keys_independent) ... ok
test_wm_never_regresses (tests.test_latefix.TestWatermarkAndEmpty.test_wm_never_regresses) ... ok

----------------------------------------------------------------------
Ran 17 tests in 0.261s

OK
EXIT=0
```

## Acceptance coverage

1. n<=10 fuzz vs batch-recompute reference: `TestReferenceFuzz.test_random_small_inputs`
   (600 random trials, exact ADD/RETRACT sequence + JSON payload comparison).
2. Lateness boundary: `TestLatenessBoundary` — correction allowed at exactly
   `end+late`, dropped at `end+late+1`; first event beyond horizon dropped.
3. Version chain: `TestVersionChain.test_two_corrections` — ADD v1 -> RETRACT/ADD
   v2 -> RETRACT/ADD v3, RETRACT payload byte-identical to previous ADD.
4. Idempotency: `TestIdempotency` — duplicates before/after finalization cause
   no versions; same ts with different val is a distinct event.

## CLI smoke test

`python -m latefix --in e.jsonl --win 30000 --late 10000` -> exit 0, correct
ADD/RETRACT stream on stdout. Non-numeric `val` -> exit 2 with stderr message.
