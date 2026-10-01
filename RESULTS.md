# walwin 测试结果（真实运行记录）

- 命令：`python -m unittest discover -v`
- 环境：Python 3.14.4（仅使用 3.11 标准库 API），Linux
- 时间：2026-10-01 03:54:49 UTC
- 退出码：0

## 实际输出（逐字记录）

```
test_empty_dir_cold_start (test_walwin.TestColdStart.test_empty_dir_cold_start) ... ok
test_empty_input_cold_start (test_walwin.TestColdStart.test_empty_input_cold_start) ... ok
test_crc_bad_tail_truncated (test_walwin.TestCrcBadTail.test_crc_bad_tail_truncated) ... ok
test_recovery_truncates_corrupt_tail_on_disk (test_walwin.TestCrcBadTail.test_recovery_truncates_corrupt_tail_on_disk) ... ok
test_duplicate_seq_across_runs (test_walwin.TestDuplicateSeq.test_duplicate_seq_across_runs) ... ok
test_duplicate_seqs_skipped (test_walwin.TestDuplicateSeq.test_duplicate_seqs_skipped) ... ok
test_pending_record_is_not_an_error (test_walwin.TestErrorsAndPending.test_pending_record_is_not_an_error) ... ok
test_unwritable_state_dir_exits_3 (test_walwin.TestErrorsAndPending.test_unwritable_state_dir_exits_3) ... ok
test_fault_points_match_reference (test_walwin.TestFaultInjection.test_fault_points_match_reference) ... ok
test_p1_p2_leave_record_unapplied (test_walwin.TestFaultInjection.test_p1_p2_leave_record_unapplied) ... ok
test_p3_leaves_wal_but_recovers_without_double_count (test_walwin.TestFaultInjection.test_p3_leaves_wal_but_recovers_without_double_count) ... ok
test_final_window_sums (test_walwin.TestWindowMath.test_final_window_sums) ... ok

----------------------------------------------------------------------
Ran 12 tests in 3.631s

OK
```

## 验收项覆盖

| 验收项 | 测试 | 结果 |
| --- | --- | --- |
| 1) P1..P4 各注入后与无故障参考比对（stdout + snapshot.json） | `TestFaultInjection.test_fault_points_match_reference` | ok |
| 1b) P1/P2 恢复等价该记录未发生 | `test_p1_p2_leave_record_unapplied` | ok |
| 1c) P3 等价已发生、WAL 残留可清且不重复计入 | `test_p3_leaves_wal_but_recovers_without_double_count` | ok |
| 2) CRC 尾坏截断（含落盘截断验证） | `TestCrcBadTail`（2 个用例） | ok |
| 3) 重复 seq 乱入（含冲突 payload、跨运行重放） | `TestDuplicateSeq`（2 个用例） | ok |
| 4) 空目录冷启动（含空输入） | `TestColdStart`（2 个用例） | ok |
| 状态目录不可写 exit 3 | `test_unwritable_state_dir_exits_3` | ok |
| 未决记录不报不可满足 | `test_pending_record_is_not_an_error` | ok |
