# 测试运行记录

命令: `python3.11 -m unittest discover -s tests -v`

解释器: Python 3.11.16 / 日期: 2026-09-30T17:37:34Z

```
test_valid_map_passes (test_checker.TestCheckerAccepts.test_valid_map_passes) ... ok
test_valid_threshold_passes (test_checker.TestCheckerAccepts.test_valid_threshold_passes) ... ok
test_incomplete_threshold_result (test_checker.TestCheckerRejects.test_incomplete_threshold_result) ... ok
test_missing_event_endpoint (test_checker.TestCheckerRejects.test_missing_event_endpoint) ... ok
test_overlapping_segments (test_checker.TestCheckerRejects.test_overlapping_segments) ... ok
test_tampered_proof (test_checker.TestCheckerRejects.test_tampered_proof) ... ok
test_unmerged_adjacent_segments (test_checker.TestCheckerRejects.test_unmerged_adjacent_segments) ... ok
test_wrong_events (test_checker.TestCheckerRejects.test_wrong_events) ... ok
test_wrong_refcounts (test_checker.TestCheckerRejects.test_wrong_refcounts) ... ok
test_wrong_total_length (test_checker.TestCheckerRejects.test_wrong_total_length) ... ok
test_add_and_intervals (test_cli.TestCli.test_add_and_intervals) ... ok
test_illegal_range_error_keeps_state (test_cli.TestCli.test_illegal_range_error_keeps_state) ... ok
test_infinity_and_length (test_cli.TestCli.test_infinity_and_length) ... ok
test_set_ops_via_cli (test_cli.TestCli.test_set_ops_via_cli) ... ok
test_threshold_and_check (test_cli.TestCli.test_threshold_and_check) ... ok
test_transactions_and_snapshots (test_cli.TestCli.test_transactions_and_snapshots) ... ok
test_unknown_op_and_bad_json (test_cli.TestCli.test_unknown_op_and_bad_json) ... ok
test_adjacent_different_sources_stay_split (test_core.TestBasicOps.test_adjacent_different_sources_stay_split) ... ok
test_adjacent_same_sources_merge (test_core.TestBasicOps.test_adjacent_same_sources_merge) ... ok
test_full_containment (test_core.TestBasicOps.test_full_containment) ... ok
test_illegal_range_changes_nothing (test_core.TestBasicOps.test_illegal_range_changes_nothing) ... ok
test_infinite_endpoints (test_core.TestBasicOps.test_infinite_endpoints) ... ok
test_overlapping_adds_split_and_merge (test_core.TestBasicOps.test_overlapping_adds_split_and_merge) ... ok
test_rational_precision (test_core.TestBasicOps.test_rational_precision) ... ok
test_remove_source_full_undo_restores_empty (test_core.TestBasicOps.test_remove_source_full_undo_restores_empty) ... ok
test_remove_source_keeps_others (test_core.TestBasicOps.test_remove_source_keeps_others) ... ok
test_remove_source_partial_range (test_core.TestBasicOps.test_remove_source_partial_range) ... ok
test_same_source_repeated_add_counts_layers (test_core.TestBasicOps.test_same_source_repeated_add_counts_layers) ... ok
test_single_add_canonical (test_core.TestBasicOps.test_single_add_canonical) ... ok
test_zero_length_add_is_noop (test_core.TestBasicOps.test_zero_length_add_is_noop) ... ok
test_endpoint_events (test_core.TestEvents.test_endpoint_events) ... ok
test_difference (test_core.TestSetOps.test_difference) ... ok
test_intersection (test_core.TestSetOps.test_intersection) ... ok
test_operands_unchanged (test_core.TestSetOps.test_operands_unchanged) ... ok
test_union (test_core.TestSetOps.test_union) ... ok
test_threshold_merges_only_equal_source_sets (test_core.TestThreshold.test_threshold_merges_only_equal_source_sets) ... ok
test_threshold_none_qualify (test_core.TestThreshold.test_threshold_none_qualify) ... ok
test_threshold_with_proofs (test_core.TestThreshold.test_threshold_with_proofs) ... ok
test_commit_keeps_changes (test_core.TestTransactionsAndSnapshots.test_commit_keeps_changes) ... ok
test_nested_commit_and_rollback (test_core.TestTransactionsAndSnapshots.test_nested_commit_and_rollback) ... ok
test_rollback_branching (test_core.TestTransactionsAndSnapshots.test_rollback_branching) ... ok
test_rollback_restores_refcounts_events_length (test_core.TestTransactionsAndSnapshots.test_rollback_restores_refcounts_events_length) ... ok
test_snapshot_save_restore (test_core.TestTransactionsAndSnapshots.test_snapshot_save_restore) ... ok
test_transaction_split_then_failure (test_core.TestTransactionsAndSnapshots.test_transaction_split_then_failure) ... ok
test_unbalanced_tx_errors (test_core.TestTransactionsAndSnapshots.test_unbalanced_tx_errors) ... ok
test_arithmetic_with_infinity (test_endpoints.TestEndpoints.test_arithmetic_with_infinity) ... ok
test_format_roundtrip (test_endpoints.TestEndpoints.test_format_roundtrip) ... ok
test_invalid (test_endpoints.TestEndpoints.test_invalid) ... ok
test_ordering_with_infinity (test_endpoints.TestEndpoints.test_ordering_with_infinity) ... ok
test_parse_infinity (test_endpoints.TestEndpoints.test_parse_infinity) ... ok
test_parse_rationals (test_endpoints.TestEndpoints.test_parse_rationals) ... ok
test_sort_key (test_endpoints.TestEndpoints.test_sort_key) ... ok
test_random_operation_streams (test_model_crosscheck.TestRandomizedCrossCheck.test_random_operation_streams) ... ok
test_full_containment (test_model_crosscheck.TestScriptedEdgeCases.test_full_containment) ... ok
test_illegal_order_is_rejected_without_side_effects (test_model_crosscheck.TestScriptedEdgeCases.test_illegal_order_is_rejected_without_side_effects) ... ok
test_infinite_endpoints (test_model_crosscheck.TestScriptedEdgeCases.test_infinite_endpoints) ... ok
test_same_endpoint_in_out (test_model_crosscheck.TestScriptedEdgeCases.test_same_endpoint_in_out) ... ok
test_same_source_repeated_add_partial_undo (test_model_crosscheck.TestScriptedEdgeCases.test_same_source_repeated_add_partial_undo) ... ok
test_zero_length_inputs (test_model_crosscheck.TestScriptedEdgeCases.test_zero_length_inputs) ... ok
test_nested_transactions_and_branching (test_model_crosscheck.TestVersioningAgainstModel.test_nested_transactions_and_branching) ... ok
test_rollback_restores_refcounts_events_length (test_model_crosscheck.TestVersioningAgainstModel.test_rollback_restores_refcounts_events_length) ... ok
test_aggregate_totals_with_infinity (test_tree.TestTree.test_aggregate_totals_with_infinity) ... ok
test_find_containing (test_tree.TestTree.test_find_containing) ... ok
test_heap_property (test_tree.TestTree.test_heap_property) ... ok
test_inorder_sorted (test_tree.TestTree.test_inorder_sorted) ... ok
test_merge_canonical_fuses_equal_sources (test_tree.TestTree.test_merge_canonical_fuses_equal_sources) ... ok
test_merge_canonical_keeps_distinct_sources (test_tree.TestTree.test_merge_canonical_keeps_distinct_sources) ... ok
test_split_at_boundary_is_noop_split (test_tree.TestTree.test_split_at_boundary_is_noop_split) ... ok
test_split_at_infinity (test_tree.TestTree.test_split_at_infinity) ... ok
test_split_at_inside_segment (test_tree.TestTree.test_split_at_inside_segment) ... ok

----------------------------------------------------------------------
Ran 70 tests in 2.908s

OK
```
