# ssi — 简化的可串行化快照隔离（SSI）

纯 Python 3.11 标准库实现，无第三方依赖。提供事务引擎（`ssi.engine`）
与 JSON 行协议 CLI（`python -m ssi`）。

## 语义

- 每个事务记录读集（`read_set`）与写集（`write_set`）；读取自 begin
  时刻的快照（读己之写除外）。
- 提交时检测危险结构：若存在并发事务对 T1、T2，T1 读的键被 T2 写、
  且 T2 读的键被 T1 写（rw 反依赖构成环），则中止当前提交者，返回
  `SERIALIZATION_FAILURE`。
- 并发定义：两事务的快照区间 `[begin_ts, commit_ts]` 有重叠。
- 只读事务永不中止。
- 写写冲突按 first-committer-wins：后提交者中止，返回 `WRITE_CONFLICT`。

## CLI 协议（JSON 行）

每条命令一行 JSON，响应也是一行 JSON：

```json
{"cmd": "begin"}                          -> {"ok": true, "tid": 1}
{"cmd": "read",  "tid": 1, "key": "x"}    -> {"ok": true, "value": 0}
{"cmd": "write", "tid": 1, "key": "x", "value": 1} -> {"ok": true}
{"cmd": "commit", "tid": 1}               -> {"ok": true}
                                             或 {"ok": false, "error": "WRITE_CONFLICT"}
                                             或 {"ok": false, "error": "SERIALIZATION_FAILURE"}
{"cmd": "abort",  "tid": 1}               -> {"ok": true}
{"cmd": "set", "key": "x", "value": 1}    -> {"ok": true}   （测试用直接写入）
{"cmd": "dump"}                           -> {"ok": true, "data": {...}}
{"cmd": "reset"}                          -> {"ok": true}
```

运行：

```sh
python -m ssi < commands.jsonl
```

（本环境中解释器名为 `python3`，下同。）

## 测试

```sh
python -m unittest discover -s tests -v
```

覆盖验收项：

- **a) 经典写偏序**：A 读 x 写 y、B 读 y 写 x，两种提交顺序下恰有一方
  `SERIALIZATION_FAILURE`（`tests/test_ssi.py::WriteSkewTest`）。
- **b) 无冲突并发**：全部提交成功（`NoConflictTest`）。
- **c) 只读事务**：与写事务并发不被中止（`ReadOnlyTest`）。
- **d) 穷举对照**：两事务、每事务不超过 3 个操作（键集 {x, y}，
  每事务 85 种程序，共 85×85×2 种提交顺序 = 14450 个用例），与参考
  可串行化判定器（枚举全部串行序）逐一比对中止决策
  （`tests/test_exhaustive.py`）。

## 真实测试结果

在本仓库实际执行（Python 3.14.4，命令 `python3 -m unittest discover -s tests -v`）：

```
test_all_small_programs_match_oracle (test_exhaustive.ExhaustiveTest.test_all_small_programs_match_oracle) ... ok
test_bad_input (test_ssi.CliTest.test_bad_input) ... ok
test_json_lines_protocol (test_ssi.CliTest.test_json_lines_protocol) ... ok
test_write_conflict_via_cli (test_ssi.CliTest.test_write_conflict_via_cli) ... ok
test_disjoint_keys (test_ssi.NoConflictTest.test_disjoint_keys) ... ok
test_shared_read_disjoint_writes (test_ssi.NoConflictTest.test_shared_read_disjoint_writes) ... ok
test_read_only_in_cycle_shape_still_commits (test_ssi.ReadOnlyTest.test_read_only_in_cycle_shape_still_commits) ... ok
test_read_only_never_aborts (test_ssi.ReadOnlyTest.test_read_only_never_aborts) ... ok
test_non_overlapping_intervals_are_not_concurrent (test_ssi.SnapshotTest.test_non_overlapping_intervals_are_not_concurrent) ... ok
test_read_own_writes (test_ssi.SnapshotTest.test_read_own_writes) ... ok
test_snapshot_isolation_reads (test_ssi.SnapshotTest.test_snapshot_isolation_reads) ... ok
test_exactly_one_survives (test_ssi.WriteSkewTest.test_exactly_one_survives) ... ok
test_skew_a_commits_first (test_ssi.WriteSkewTest.test_skew_a_commits_first) ... ok
test_skew_b_commits_first (test_ssi.WriteSkewTest.test_skew_b_commits_first) ... ok
test_first_committer_wins (test_ssi.WriteWriteConflictTest.test_first_committer_wins) ... ok
test_loser_may_retry (test_ssi.WriteWriteConflictTest.test_loser_may_retry) ... ok

----------------------------------------------------------------------
Ran 16 tests in 0.510s

OK
```

## 结构

- `ssi/engine.py` — 事务引擎：快照读、写写冲突、危险结构检测。
- `ssi/cli.py` / `ssi/__main__.py` — JSON 行协议 CLI。
- `tests/test_ssi.py` — 验收 a/b/c、写写冲突、快照语义、CLI。
- `tests/test_exhaustive.py` — 验收 d：穷举对照参考判定器。
