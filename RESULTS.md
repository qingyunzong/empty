# snapidx — 实现与验收结果

内存快照索引库，Python 3.11 标准库实现（无第三方依赖），unittest 测试，可运行 CLI。

## 文件

- `snapidx.py` — 核心库 `SnapIdx` + CLI（`python3 snapidx.py [--log PATH]`，从 stdin 读命令）
- `test_snapidx.py` — unittest 验收测试（A/B/C/D + 核心语义 + CLI）
- `RESULTS.md` — 本文件，记录真实运行输出

## 设计要点

- 事务栈：`begin` 压入一层变更；内层 `commit` 仅并入父层；最外层 `commit` 才落 committed 状态、递增序号、拍快照、写日志。
- 快照：每次非空最外层 commit 保存 `{seq: 状态副本}`；`search(term, snapshot=S)` 只读该副本，与后续写完全隔离。
- 空事务 commit 合法且序号不增；`del` 不存在 id 为 no-op（不使事务变非空）；重复 `add` 同 id 覆盖。
- 日志：JSON Lines，仅在最外层非空 commit 时追加 `op 记录 + {"commit": N}` 并 fsync。恢复时只应用被 commit 标记封口的记录；半截 JSON 记录丢弃并 warn；未封口的 op 记录（崩溃残留）忽略。
- 错误：未知 snapshot、无事务 rollback/commit → CLI 退出码 3。

## 测试结果（真实输出）

`python3 -m unittest -v`（Python 3.14.4，代码兼容 3.11）：

```
test_random_sequences_match_model (TestA_ModelEnumeration) ... ok      # A: 300 组随机小序列对照独立模型
test_inner_commit_merges_outward (TestB_NestedRollback) ... ok
test_three_level_rollback (TestB_NestedRollback) ... ok                # B: 三层嵌套回滚
test_basic_session (TestCLI) ... ok
test_cli_persistence_roundtrip (TestCLI) ... ok
test_rollback_without_transaction_exit_3 (TestCLI) ... ok
test_unknown_snapshot_exit_3 (TestCLI) ... ok
test_interleaved_add_commit_keeps_old_snapshot (TestC_SnapshotIsolation) ... ok
test_threaded_interleave (TestC_SnapshotIsolation) ... ok              # C: 3 写线程 + 3 读线程交替，快照结果恒定
test_commit_without_transaction_raises (TestCoreSemantics) ... ok
test_del_missing_id_is_noop_and_keeps_tx_empty (TestCoreSemantics) ... ok
test_empty_commit_does_not_advance_sequence (TestCoreSemantics) ... ok
test_readd_same_id_overwrites (TestCoreSemantics) ... ok
test_rollback_without_transaction_raises (TestCoreSemantics) ... ok
test_uncommitted_invisible_to_snapshots (TestCoreSemantics) ... ok
test_unknown_snapshot_raises (TestCoreSemantics) ... ok
test_crash_between_ops_and_commit_marker (TestD_LogRecovery) ... ok
test_recover_full_log (TestD_LogRecovery) ... ok
test_truncate_at_record_boundary (TestD_LogRecovery) ... ok            # D: 记录边界截断
test_truncate_mid_record (TestD_LogRecovery) ... ok                    # D: 半条记录截断 + warn

----------------------------------------------------------------------
Ran 20 tests in 0.249s

OK
```

## CLI 实测（真实输出）

### 1. 快照隔离：交替 add/commit，旧快照结果不变

```
$ printf 'begin\nadd 1 apple pie\nadd 2 apple tart\ncommit\nbegin\nadd 3 banana split\ncommit\nsearch apple\nsearch apple --snapshot 1\nsearch apple --snapshot 2\nsearch banana --snapshot 1\nexit\n' | python3 snapidx.py
ok
ok
ok
seq 1
ok
ok
seq 2
1 2
1 2
1 2
                ← search banana --snapshot 1 为空行：commit 2 对快照 1 不可见
exit=0
```

### 2. 三层嵌套回滚：rollback 只撤销当前层

```
$ printf 'begin\nadd a term-a\nbegin\nadd b term-b\nbegin\nadd c term-c\nrollback\nsearch term-c\nrollback\nsearch term-b\ncommit\nsearch term-a --snapshot 1\nexit\n' | python3 snapidx.py
ok ok ok ok ok ok ok
                ← search term-c 为空（L3 已撤销）
                ← search term-b 为空（L2 已撤销）
seq 1           ← 外层 L1 继续并提交成功
a
```

### 3. 错误退出码 3

```
$ printf 'rollback\n' | python3 snapidx.py
error: rollback without active transaction
exit=3
$ printf 'search x --snapshot 9\n' | python3 snapidx.py
error: unknown snapshot: 9
exit=3
```

### 4. 空事务提交：合法且序号不增

```
$ printf 'begin\ncommit\nbegin\nadd 1 hi\ncommit\nexit\n' | python3 snapidx.py
ok
seq 0           ← 空事务，序号未增
ok
ok
seq 1
```

### 5. 持久化与截断恢复

```
$ printf 'add 1 alpha\nadd 2 beta\nbegin\nadd 3 gamma\ncommit\nexit\n' | python3 snapidx.py --log idx.log
ok ok ok ok
seq 3

$ cat idx.log
{"op": "add", "id": "1", "text": "alpha"}
{"commit": 1}
{"op": "add", "id": "2", "text": "beta"}
{"commit": 2}
{"op": "add", "id": "3", "text": "gamma"}
{"commit": 3}

# 完整恢复
$ printf 'search alpha\nsearch gamma\nexit\n' | python3 snapidx.py --log idx.log
1
3

# 记录边界截断（去掉 commit 3 的两条记录）：干净恢复到 seq 2，无警告
$ head -n 4 idx.log > boundary.log
$ printf 'search gamma\nsearch beta\nexit\n' | python3 snapidx.py --log boundary.log
                ← gamma 不存在（未 commit 的记录被忽略）
2
exit=0

# 半条记录截断（第 140 字节处切断）：半条记录丢弃并 warn，恢复到 seq 2
$ head -c 140 idx.log > half.log
$ printf 'search gamma\nsearch beta\nexit\n' | python3 snapidx.py --log half.log
snapidx: discarding incomplete log record: b'{"op": "add", "id": "3", "tex'
                ← gamma 不存在
2
exit=0
```
