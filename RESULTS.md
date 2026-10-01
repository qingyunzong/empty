# Test Results

Date: 2026-10-01
Environment: Python 3.14.4 (code targets Python 3.11 stdlib), Linux

Note: this environment provides `python3` only (`python` is not on
PATH), so the suite was executed as `python3 -m unittest discover -v`
from the repository root. The command is otherwise identical to the
required `python -m unittest discover -v`.

## Command

```
python3 -m unittest discover -v
```

## Real exit code

```
0
```

## Output

```
test_exact_end_plus_late_boundary (tests.test_latefix.BoundaryTest.test_exact_end_plus_late_boundary) ... ok
test_one_past_boundary_dropped (tests.test_latefix.BoundaryTest.test_one_past_boundary_dropped) ... ok
test_cli_boolean_val_exits_2 (tests.test_latefix.CliTest.test_cli_boolean_val_exits_2) ... ok
test_cli_clock_regression_does_not_exit (tests.test_latefix.CliTest.test_cli_clock_regression_does_not_exit) ... ok
test_cli_happy_path (tests.test_latefix.CliTest.test_cli_happy_path) ... ok
test_cli_non_numeric_val_exits_2 (tests.test_latefix.CliTest.test_cli_non_numeric_val_exits_2) ... ok
test_empty_input_no_output (tests.test_latefix.EmptyWindowTest.test_empty_input_no_output) ... ok
test_empty_windows_never_emit (tests.test_latefix.EmptyWindowTest.test_empty_windows_never_emit) ... ok
test_random_small_inputs_match_reference (tests.test_latefix.FuzzAgainstReferenceTest.test_random_small_inputs_match_reference) ... ok
test_streaming_output_is_well_formed (tests.test_latefix.FuzzAgainstReferenceTest.test_streaming_output_is_well_formed) ... ok
test_duplicate_before_emission_counts_once (tests.test_latefix.IdempotencyTest.test_duplicate_before_emission_counts_once) ... ok
test_duplicate_events_are_idempotent (tests.test_latefix.IdempotencyTest.test_duplicate_events_are_idempotent) ... ok
test_retract_byte_equal_to_last_add (tests.test_latefix.VersionChainTest.test_retract_byte_equal_to_last_add) ... ok
test_two_corrections_version_chain (tests.test_latefix.VersionChainTest.test_two_corrections_version_chain) ... ok
test_clock_regression_ignored_not_fatal (tests.test_latefix.WatermarkTest.test_clock_regression_ignored_not_fatal) ... ok

----------------------------------------------------------------------
Ran 15 tests in 0.728s

OK
```

## Acceptance criteria coverage

1. `FuzzAgainstReferenceTest` — 500 random cases with n <= 10 compare
   the streaming engine against the batch-recompute reference
   (`run_reference`), validating the full ADD/RETRACT sequence.
2. `BoundaryTest` — correction applied at exactly `WM == end + late`,
   dropped at `end + late + 1`.
3. `VersionChainTest` — two consecutive corrections produce the
   version chain v1 -> v2 -> v3, and each RETRACT is byte-equal to the
   last ADD value.
4. `IdempotencyTest` — repeated physical events produce no extra
   versions and are counted once.

Additionally: `CliTest` verifies exit code 2 for non-numeric `val`
(including JSON booleans) and that clock regressions do not cause a
non-zero exit; `EmptyWindowTest` / `WatermarkTest` cover empty-window
silence and watermark monotonicity.
