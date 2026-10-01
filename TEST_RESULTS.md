# 测试结果记录

命令：`python3.11 -m unittest discover -s tests -v`（Python 3.11.16，退出码 0）

```
test_rejects_bad_evidence (test_checker.CheckerTest.test_rejects_bad_evidence) ... ok
test_rejects_interior_point_left_out (test_checker.CheckerTest.test_rejects_interior_point_left_out) ... ok
test_rejects_missing_vertex (test_checker.CheckerTest.test_rejects_missing_vertex) ... ok
test_rejects_phantom_vertex (test_checker.CheckerTest.test_rejects_phantom_vertex) ... ok
test_rejects_wrong_order (test_checker.CheckerTest.test_rejects_wrong_order) ... ok
test_valid_hull_passes (test_checker.CheckerTest.test_valid_hull_passes) ... ok
test_float_rejected_and_errors_recoverable (test_cli.CliTest.test_float_rejected_and_errors_recoverable) ... ok
test_session (test_cli.CliTest.test_session) ... ok
test_all_collinear (test_dynamic.RandomUpdatesTest.test_all_collinear) ... ok
test_delete_bridging_extreme_point (test_dynamic.RandomUpdatesTest.test_delete_bridging_extreme_point) ... ok
test_duplicate_coordinates (test_dynamic.RandomUpdatesTest.test_duplicate_coordinates) ... ok
test_near_fractions_exactness (test_dynamic.RandomUpdatesTest.test_near_fractions_exactness) ... ok
test_nested_snapshots_and_diverge (test_dynamic.RandomUpdatesTest.test_nested_snapshots_and_diverge) ... ok
test_random_updates_match_bruteforce (test_dynamic.RandomUpdatesTest.test_random_updates_match_bruteforce) ... ok
test_rejects_floats (test_dynamic.RandomUpdatesTest.test_rejects_floats) ... ok
test_save_and_load (test_dynamic.RandomUpdatesTest.test_save_and_load) ... ok
test_long_sequence_node_visits (test_locality.LocalityTest.test_long_sequence_node_visits) ... ok
test_summary_merge_is_local (test_locality.LocalityTest.test_summary_merge_is_local) ... ok
test_degenerate_hulls (test_queries.QueryTest.test_degenerate_hulls) ... ok
test_extreme_matches_bruteforce (test_queries.QueryTest.test_extreme_matches_bruteforce) ... ok
test_extreme_tie_rule (test_queries.QueryTest.test_extreme_tie_rule) ... ok
test_tangent_collinear_tie (test_queries.QueryTest.test_tangent_collinear_tie) ... ok
test_tangent_inside_is_none (test_queries.QueryTest.test_tangent_inside_is_none) ... ok
test_tangent_matches_bruteforce (test_queries.QueryTest.test_tangent_matches_bruteforce) ... ok

----------------------------------------------------------------------
Ran 24 tests in 340.951s

OK

[locality] ops=5000 final_size=3038
[locality] created/op: max=56 avg=17.9 bound=117 (8*log2(n)+24)
[locality] visited/op: max=27 total_visited=72298
```
