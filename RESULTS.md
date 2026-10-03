# asofjoin 测试结果

## 运行环境

- Python: `Python 3.14.4`（本机仅有 `python3`，无 `python` 别名，故以 `python3 -m unittest discover -v` 执行；命令行接口仍为 `python -m asofjoin` 形式）
- 平台: Linux (workspace 容器)
- 日期: 2026-10-04

## 运行命令

```
python3 -m unittest discover -v
```

## 真实输出（未删减）

```
test_deterministic_output_order (tests.test_asofjoin.TestBruteForceEnumeration.test_deterministic_output_order) ... ok
test_random_small_cases_match_reference (tests.test_asofjoin.TestBruteForceEnumeration.test_random_small_cases_match_reference) ... ok
test_cli_bad_json_line_exit2 (tests.test_asofjoin.TestCli.test_cli_bad_json_line_exit2) ... ok
test_cli_bad_ts_type_exit2 (tests.test_asofjoin.TestCli.test_cli_bad_ts_type_exit2) ... ok
test_cli_dim_missing_attr_exit2 (tests.test_asofjoin.TestCli.test_cli_dim_missing_attr_exit2) ... ok
test_cli_happy_path (tests.test_asofjoin.TestCli.test_cli_happy_path) ... ok
test_cli_missing_field_exit2 (tests.test_asofjoin.TestCli.test_cli_missing_field_exit2) ... ok
test_cli_missing_file_exit2 (tests.test_asofjoin.TestCli.test_cli_missing_file_exit2) ... ok
test_cli_negative_tol_exit2 (tests.test_asofjoin.TestCli.test_cli_negative_tol_exit2) ... ok
test_later_arrival_with_higher_ts_overrides (tests.test_asofjoin.TestDimDedup.test_later_arrival_with_higher_ts_overrides) ... ok
test_lower_ts_later_arrival_no_effect (tests.test_asofjoin.TestDimDedup.test_lower_ts_later_arrival_no_effect) ... ok
test_override_removes_old_record_from_join (tests.test_asofjoin.TestDimDedup.test_override_removes_old_record_from_join) ... ok
test_same_ts_later_arrival_invalid (tests.test_asofjoin.TestDimDedup.test_same_ts_later_arrival_invalid) ... ok
test_late_dim_updates_pending_fact (tests.test_asofjoin.TestLateDimTiming.test_late_dim_updates_pending_fact) ... ok
test_missing_dim_not_prematurely_unsatisfiable (tests.test_asofjoin.TestLateDimTiming.test_missing_dim_not_prematurely_unsatisfiable) ... ok
test_out_of_order_dims_file_still_joins (tests.test_asofjoin.TestLateDimTiming.test_out_of_order_dims_file_still_joins) ... ok
test_without_late_dim_fact_would_be_stale (tests.test_asofjoin.TestLateDimTiming.test_without_late_dim_fact_would_be_stale) ... ok
test_boundary_age_equal_tol_matches (tests.test_asofjoin.TestStaleVsNoDim.test_boundary_age_equal_tol_matches) ... ok
test_boundary_age_tol_plus_one_is_stale (tests.test_asofjoin.TestStaleVsNoDim.test_boundary_age_tol_plus_one_is_stale) ... ok
test_no_dim_when_key_never_seen (tests.test_asofjoin.TestStaleVsNoDim.test_no_dim_when_key_never_seen) ... ok
test_no_dim_when_only_future_dims (tests.test_asofjoin.TestStaleVsNoDim.test_no_dim_when_only_future_dims) ... ok
test_stale_when_newest_dim_too_old (tests.test_asofjoin.TestStaleVsNoDim.test_stale_when_newest_dim_too_old) ... ok
test_same_ts_picks_lexicographically_smallest_did (tests.test_asofjoin.TestTieBreak.test_same_ts_picks_lexicographically_smallest_did) ... ok
test_tie_only_among_in_window_dims (tests.test_asofjoin.TestTieBreak.test_tie_only_among_in_window_dims) ... ok
test_negative_tol_rejected (tests.test_asofjoin.TestValidation.test_negative_tol_rejected) ... ok
test_zero_tol_requires_exact_ts (tests.test_asofjoin.TestValidation.test_zero_tol_requires_exact_ts) ... ok
test_fact_not_emitted_until_dwm_passes (tests.test_asofjoin.TestWatermarkSemantics.test_fact_not_emitted_until_dwm_passes) ... ok
test_fact_not_emitted_until_fwm_passes (tests.test_asofjoin.TestWatermarkSemantics.test_fact_not_emitted_until_fwm_passes) ... ok
test_fact_with_ts_equal_fwm_kept (tests.test_asofjoin.TestWatermarkSemantics.test_fact_with_ts_equal_fwm_kept) ... ok
test_late_fact_dropped (tests.test_asofjoin.TestWatermarkSemantics.test_late_fact_dropped) ... ok

----------------------------------------------------------------------
Ran 30 tests in 1.757s

OK
```

## 结果摘要

- 共 30 个测试，全部通过（OK），无 failure / error / skip。
- 验收点覆盖：
  1. `TestBruteForceEnumeration`：600 个 n<=9 的随机枚举用例与暴力参考逐一比对，输出顺序确定性。
  2. `TestTieBreak`：维度 ts 并列时由 did 字典序最小者胜出。
  3. `TestLateDimTiming`：维度晚到但在 tol 内时改变挂起事实的结果；未到期维度缺失不被当作不可满足。
  4. `TestStaleVsNoDim`：stale（有维度但超出 tol）与 no_dim（无 ts<=fact.ts 的同 key 维度）区分，含 tol 边界。
  5. 另有水位线门控、迟到事实丢弃、重复 did 覆盖规则、CLI 坏行/tol<0 exit 2 等测试。
