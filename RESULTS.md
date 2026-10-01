# dedupwin 测试结果

## 环境
- Python: 3.14.4（代码仅使用 3.11 标准库：argparse / json / dataclasses / unittest）
- 日期: 2026-10-01
- 命令: `python3 -m unittest discover -v`（环境无 `python` 别名，使用 `python3`）

## 真实运行输出

```
test_cli_end_to_end (tests.test_dedupwin.CliTest.test_cli_end_to_end) ... ok
test_cli_missing_id_exits_2 (tests.test_dedupwin.CliTest.test_cli_missing_id_exits_2) ... ok
test_cli_missing_ts_exits_2 (tests.test_dedupwin.CliTest.test_cli_missing_ts_exits_2) ... ok
test_cli_negative_ts_marked_bad (tests.test_dedupwin.CliTest.test_cli_negative_ts_marked_bad) ... ok
test_cli_replay_is_deterministic (tests.test_dedupwin.CliTest.test_cli_replay_is_deterministic) ... ok
test_conflict_first_wins (tests.test_dedupwin.ConflictTest.test_conflict_first_wins) ... ok
test_earlier_ts_wins_even_if_arriving_later (tests.test_dedupwin.ConflictTest.test_earlier_ts_wins_even_if_arriving_later) ... ok
test_identical_duplicate_is_not_a_conflict (tests.test_dedupwin.ConflictTest.test_identical_duplicate_is_not_a_conflict) ... ok
test_same_ts_stable_by_input_order (tests.test_dedupwin.ConflictTest.test_same_ts_stable_by_input_order) ... ok
test_empty_input (tests.test_dedupwin.ErrorHandlingTest.test_empty_input) ... ok
test_missing_id_raises (tests.test_dedupwin.ErrorHandlingTest.test_missing_id_raises) ... ok
test_missing_ts_raises (tests.test_dedupwin.ErrorHandlingTest.test_missing_ts_raises) ... ok
test_negative_ts_is_bad (tests.test_dedupwin.ErrorHandlingTest.test_negative_ts_is_bad) ... ok
test_boundary_exact_is_kept (tests.test_dedupwin.EvictionBoundaryTest.test_boundary_exact_is_kept) ... ok
test_evicted_winner_never_emitted (tests.test_dedupwin.EvictionBoundaryTest.test_evicted_winner_never_emitted) ... ok
test_one_below_boundary_is_evicted (tests.test_dedupwin.EvictionBoundaryTest.test_one_below_boundary_is_evicted) ... ok
test_large_skew_keeps_state_and_output (tests.test_dedupwin.LargeSkewTest.test_large_skew_keeps_state_and_output) ... ok
test_lower_bound_moves_only_with_max_ts (tests.test_dedupwin.LargeSkewTest.test_lower_bound_moves_only_with_max_ts) ... ok
test_exhaustive_small (tests.test_dedupwin.PermutationTest.test_exhaustive_small) ... ok
test_lower_bound_filters_old_events (tests.test_dedupwin.PermutationTest.test_lower_bound_filters_old_events) ... ok
test_random_permutations_n10 (tests.test_dedupwin.PermutationTest.test_random_permutations_n10) ... ok
test_reversed_and_rotations (tests.test_dedupwin.PermutationTest.test_reversed_and_rotations) ... ok

----------------------------------------------------------------------
Ran 22 tests in 1.698s

OK
```

## 验收标准覆盖

1. **乱序排列一致性** (`PermutationTest`)：6 事件全排列（720 种）穷举 + 10 事件 300 次随机打乱 +
   反转/全部旋转，输出均与"先按 (ts,id,输入序) 排序再去重"的参考实现一致；另有紧 skew/ret 下
   L 裁剪旧事件的 100 次随机排列。
2. **重复 id 冲突** (`ConflictTest`)：字段不一致记 `conflicts` 且首条（(ts,输入序) 最小者）为准；
   相同字段重复不记冲突；同 ts 按输入序稳定。
3. **驱逐边界** (`EvictionBoundaryTest`)：`id_max_ts == L - ret` 恰好保留（严格小于才驱逐），
   差 1 即驱逐；被驱逐 id 的 winner 永不输出。
4. **大 skew 不误判丢失** (`LargeSkewTest`)：skew=1e9 时 max_ts 大幅推进后，旧 id 状态保留、
   迟到重复仍去重、迟到新 id 仍正常输出。

## CLI 冒烟测试（真实运行）

```
$ python3 -m dedupwin --in /tmp/e.jsonl --skew 10000 --ret 60000
{"id": "b", "key": "k1", "ts": 1000, "val": "b1"}
{"id": "a", "key": "k1", "ts": 5000, "val": "first"}
# stderr: {"bad": 1, "conflicts": 1, "duplicates": 1, "evicted": 0, "kept_ids": 2, ...}
# exit=0

$ python3 -m dedupwin --in /tmp/bad.jsonl --skew 1 --ret 1   # 缺 ts
error: line 1: record missing 'ts'
# exit=2
```
