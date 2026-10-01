# recovery — WAL + 定期检查点的页式存储

Python 3.11 标准库实现的 ARIES 风格崩溃恢复（steal / no-force 缓冲策略）。

## 结构

- `recovery/storage.py` — 页式磁盘文件 `pages.db`：8 个 128 字节页，每页 8 字节
  pageLSN 头 + 15 个 8 字节整数槽位；key 确定性映射到 (page, slot)。
- `recovery/wal.py` — 预写日志 `wal.log`（JSON lines，追加写 + fsync）。记录类型：
  `begin / update / commit / end / clr / checkpoint`。
- `recovery/engine.py` — 缓冲池、脏页表（recLSN）、事务表、严格两阶段锁；
  `checkpoint / crash / recover` 的实现。
- `recovery/__main__.py` — 命令行接口。
- `tests/test_recovery.py` — unittest 验收测试。

## 语义

1. **Checkpoint**：记录当前脏页集合 `{page: recLSN}` 与活跃事务表
   `{txn: lastLSN}` 到 WAL，随后把脏页刷盘。
2. **两阶段恢复**：redo 从最近 checkpoint 的最小 recLSN 起按 LSN 升序重放；
   undo 按 LSN 逆序回滚崩溃时仍活跃的事务（loser transactions）。
3. **幂等 redo**：每页带 pageLSN，仅当日志记录 LSN 大于 pageLSN 时才应用。
4. **CLR**：undo 每步写补偿日志记录（含 `undo_next`），重复恢复不会重复回滚。
5. **故障点**：`crash` 命令执行时刻；此后缓冲池、脏页表、事务表、锁表等
   进程内状态全部丢弃，仅 `pages.db` 与 `wal.log` 保留。

并发正确性：引擎对 key 加严格两阶段锁（`put` 冲突时抛 `LockConflict`），
保证 undo 用前像回滚时值未被其他活跃事务覆盖。

## CLI

```
python -m recovery <datadir> [script.txt]   # 无脚本时从 stdin 读命令
```

命令（每行一条，`#` 为注释）：

```
put <txn> <key> <value>   # 在事务 txn 下写入（事务隐式 begin）
commit <txn>
abort <txn>
checkpoint
crash
recover
dump                      # 输出全部槽位，格式 key=value
```

示例：

```
$ printf 'put 1 3 42\nput 2 4 99\ncommit 1\ncheckpoint\ncrash\nrecover\ndump\n' \
    | python -m recovery /tmp/demo
...
3=42        # 已提交，恢复后可见
4=0         # 未提交，已被 undo 回滚
```

## 测试

```
python -m unittest discover -s tests -v
```

覆盖验收标准：

- `test_a_crash_before_and_after_checkpoint_same_result` — 崩溃点位于
  checkpoint 之前/之后，恢复结果一致；
- `test_b_only_committed_visible_after_recovery` — 混合已提交/未提交事务
  （未提交数据已被 checkpoint 刷到磁盘），恢复后仅已提交可见；
- `test_c_double_recover_is_idempotent` — 对同一崩溃状态连续两次 recover
  （以及 crash 后再 recover），结果不变；
- `test_d_matches_full_replay_reference` — 随机负载（put/commit/abort/
  checkpoint，120 步）恢复后与全量重放参考实现比对最终库态；
- `test_e_cli_end_to_end` — CLI 端到端。

## 真实测试结果

在本机（Python 3.14.4，代码兼容 3.11）实际运行输出：

```
test_a_crash_before_and_after_checkpoint_same_result ... ok
test_b_only_committed_visible_after_recovery ... ok
test_c_double_recover_is_idempotent ... ok
test_d_matches_full_replay_reference ... ok
test_e_cli_end_to_end ... ok

----------------------------------------------------------------------
Ran 5 tests in 0.197s

OK
```

另用 50 个随机种子（每种子 50–300 步混合负载）做了恢复结果与全量重放
参考实现的一致性压测，全部一致（`fails = 0`）。
