# recovery — WAL + 定期检查点的页式存储

Python 3.11+ 标准库实现的 ARIES 风格崩溃恢复键值存储，无任何第三方依赖。

## 设计

- **页式存储**（`recovery/storage.py`）：`data.db` 固定 16 个 4KiB 页槽，每页头部
  8 字节 `pageLSN` + JSON 负载（key→value）。`pageLSN` 是已反映到该页的最大日志 LSN。
- **WAL**（`recovery/wal.py`）：`wal.log` 追加式 JSON Lines，每条记录带单调递增 LSN，
  append 即 flush + fsync，保证已确认的日志在崩溃后存活。
- **引擎**（`recovery/engine.py`）：LRU 缓冲池（容量 4 页）、脏页表 DPT
  （page→recLSN）、事务表 TT（txn→status/lastLSN）。`crash` 丢弃全部进程内状态，
  仅磁盘文件保留。
- **日志记录类型**：`BEGIN` / `UPDATE(before,after)` / `COMMIT` / `END` /
  `CLR(undo_next)` / `CHECKPOINT`。

## 语义

1. **Checkpoint**：`CHECKPOINT` 记录携带 DPT 快照（脏页→recLSN）与活跃事务表快照，
   随后把所有脏页刷盘。
2. **两阶段恢复**（分析 + redo + undo）：
   - 分析：从最近 checkpoint 重建 DPT/TT，扫描至日志尾，区分 winner（已提交）与
     loser（崩溃时仍活跃）事务。
   - redo：从 DPT 最小 recLSN 起按 LSN 顺序重放 `UPDATE`/`CLR`，仅当
     `日志LSN > pageLSN` 才应用，幂等。
   - undo：沿 prevLSN 链逆序回滚 loser，每步写一条 CLR（带 `undo_next`），
     事务完全回滚后写 `END`。
3. **故障点**：`crash` 命令执行时刻；之后缓冲池、DPT、TT 全部丢弃，只有
   `wal.log` 与 `data.db` 保留。

## CLI

```bash
python -m recovery --dir DBDIR "put t1 a 1" "put t1 b 2" "commit t1" \
    checkpoint "put t2 c 3" crash recover dump
# 或从文件/标准输入读取命令（每行一条）：
python -m recovery --dir DBDIR --script ops.txt
```

命令：`put TXN KEY VALUE`（隐式 begin）、`commit TXN`、`checkpoint`、`crash`、
`recover`、`dump`（输出排序后的 `k=v` 行）。

## 参考实现

`recovery/reference.py` 忽略 checkpoint 与 pageLSN，对整条 WAL 做全量逻辑重放
（仅应用已提交事务的 UPDATE），用于与恢复结果比对最终库态。

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖验收标准：
- (a) 崩溃点位于 checkpoint 之前/之后/无 checkpoint，恢复结果一致；
- (b) 混合已提交/未提交事务（含 checkpoint 把未提交脏页刷盘的情形），恢复后仅已提交可见；
- (c) 对同一崩溃状态连续两次 `recover`，dump、`data.db`、`wal.log` 字节完全一致，
  第二次 redone=0、clrs=0；
- (d) 多种子随机负载（含中途 crash/recover 续跑）与全量重放参考实现比对最终库态一致；
- 另含 checkpoint 记录内容、CLR/END 生成、pageLSN 幂等、CLI 端到端与跨进程恢复测试。

## 真实测试结果

在交付环境（Python 3.14.4）实际运行：

```
$ python -m unittest discover -s tests -v
test_crash_before_and_after_checkpoint_same_result (test_recovery.CheckpointPlacementTest.test_crash_before_and_after_checkpoint_same_result) ... ok
test_checkpoint_contains_dpt_and_tt (test_recovery.CheckpointRecordTest.test_checkpoint_contains_dpt_and_tt) ... ok
test_cli_end_to_end (test_recovery.CliTest.test_cli_end_to_end) ... ok
test_cli_recover_in_separate_process (test_recovery.CliTest.test_cli_recover_in_separate_process) ... ok
test_double_recover_is_noop (test_recovery.IdempotentRecoveryTest.test_double_recover_is_noop) ... ok
test_page_lsn_blocks_reapplication (test_recovery.IdempotentRecoveryTest.test_page_lsn_blocks_reapplication) ... ok
test_only_committed_visible (test_recovery.MixedTransactionsTest.test_only_committed_visible) ... ok
test_undo_writes_compensation_records (test_recovery.MixedTransactionsTest.test_undo_writes_compensation_records) ... ok
test_matches_full_replay_reference (test_recovery.ReferenceComparisonTest.test_matches_full_replay_reference) ... ok

----------------------------------------------------------------------
Ran 9 tests in 0.144s

OK
```
