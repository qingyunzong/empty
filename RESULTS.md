# RESULTS

Date: 2026-10-01 11:41:23 CST
Python: Python 3.14.4

## `python -m unittest discover -v`

```
test_cascade_all_three_layers (test_hieroll.CascadeCorrectionTest.test_cascade_all_three_layers) ... ok
test_cli_end_to_end (test_hieroll.CliTest.test_cli_end_to_end) ... ok
test_cli_negative_delta_and_correction (test_hieroll.CliTest.test_cli_negative_delta_and_correction) ... ok
test_cli_non_integer_delta_exit2 (test_hieroll.CliTest.test_cli_non_integer_delta_exit2) ... ok
test_cli_too_late_drop_count (test_hieroll.CliTest.test_cli_too_late_drop_count) ... ok
test_correction_only_emits_1m (test_hieroll.LeafOnlyCorrectionTest.test_correction_only_emits_1m) ... ok
test_random_against_reference (test_hieroll.RandomizedReferenceTest.test_random_against_reference) ... ok
test_too_late_dropped_and_counted (test_hieroll.TooLateDropTest.test_too_late_dropped_and_counted) ... ok

----------------------------------------------------------------------
Ran 8 tests in 3.401s

OK
```

Exit code: 0
