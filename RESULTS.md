# RESULTS

Date: 2026-10-01 02:26:16 CST
Python: Python 3.14.4

## Command

```
python3 -m unittest discover -v
```

Note: this environment provides only the `python3` interpreter (no `python`
alias); the module and CLI are pure Python 3.11+ standard library, so
`python -m unittest discover -v` and `python -m dedupwin ...` work verbatim
on any system where `python` points to Python >= 3.11.

## Output

```
test_cli_output_sorted_deduped (tests.test_dedupwin.TestCliEndToEnd.test_cli_output_sorted_deduped) ... ok
test_conflict_first_wins (tests.test_dedupwin.TestConflicts.test_conflict_first_wins) ... ok
test_identical_duplicate_no_conflict (tests.test_dedupwin.TestConflicts.test_identical_duplicate_no_conflict) ... ok
test_cli_missing_field_exit2 (tests.test_dedupwin.TestErrors.test_cli_missing_field_exit2) ... ok
test_missing_id_raises (tests.test_dedupwin.TestErrors.test_missing_id_raises) ... ok
test_missing_ts_raises (tests.test_dedupwin.TestErrors.test_missing_ts_raises) ... ok
test_negative_ts_is_bad (tests.test_dedupwin.TestErrors.test_negative_ts_is_bad) ... ok
test_id_at_boundary_is_retained (tests.test_dedupwin.TestEvictionBoundary.test_id_at_boundary_is_retained) ... ok
test_id_below_boundary_is_evicted (tests.test_dedupwin.TestEvictionBoundary.test_id_below_boundary_is_evicted) ... ok
test_event_below_lower_bound_dropped (tests.test_dedupwin.TestLargeSkew.test_event_below_lower_bound_dropped) ... ok
test_future_id_within_skew_window_accepted (tests.test_dedupwin.TestLargeSkew.test_future_id_within_skew_window_accepted) ... ok
test_full_tie_first_input_wins (tests.test_dedupwin.TestPermutations.test_full_tie_first_input_wins) ... ok
test_permutations_match_reference (tests.test_dedupwin.TestPermutations.test_permutations_match_reference) ... ok
test_replay_deterministic (tests.test_dedupwin.TestPermutations.test_replay_deterministic) ... ok
test_same_ts_stable_by_input_order (tests.test_dedupwin.TestPermutations.test_same_ts_stable_by_input_order) ... ok

----------------------------------------------------------------------
Ran 15 tests in 0.440s

OK
```
