# si — 快照隔离事务引擎

基于 MVCC 的快照隔离（Snapshot Isolation）键值事务引擎，纯 Python 标准库实现（兼容 3.11+），无第三方依赖。

## 语义

1. 事务 `begin` 时获取一致性快照，读永不阻塞，且读不到快照点之后提交的数据。
2. 提交时若写集中任一键被其它事务在其快照点之后提交修改，整个事务以
   `WRITE_CONFLICT` 失败且不产生任何效果（first-committer-wins）。
3. 冲突检测基于键集合，不做值比较（两事务写相同值仍冲突）。
4. 失败事务可安全 abort 并重试。

## 布局

- `si/engine.py` — MVCC 引擎：`begin` / `read` / `write` / `commit` / `abort`
- `si/cli.py` — JSON 行协议 CLI（`python3 -m si`）
- `tests/` — unittest 验收测试

## CLI 协议

每行一个 JSON 请求，每行一个 JSON 响应。事务命令带 `txn` 字段。

```
{"cmd": "begin",  "txn": "t1"}                          -> {"ok": true, "snapshot": N}
{"cmd": "read",   "txn": "t1", "key": "x"}              -> {"ok": true, "value": V|null}
{"cmd": "write",  "txn": "t1", "key": "x", "value": V}  -> {"ok": true}
{"cmd": "commit", "txn": "t1"}                          -> {"ok": true} | {"error": "WRITE_CONFLICT"}
{"cmd": "abort",  "txn": "t1"}                          -> {"ok": true}
{"cmd": "dump"}                                         -> {"ok": true, "state": {...}}
```

错误码：`WRITE_CONFLICT`、`UNKNOWN_TXN`、`TXN_EXISTS`、`UNKNOWN_COMMAND`、
`INVALID_COMMAND`、`INVALID_JSON`。

## 测试

```
python3 -m unittest discover -s tests -v
```

覆盖验收标准：

- a) `test_a_first_committer_wins_on_same_key` — 同键并发写，先提交者成功，后者 `WRITE_CONFLICT`
- b) `test_b_disjoint_write_sets_both_commit` — 不相交写集两事务均成功
- c) `test_c_write_skew_is_allowed` — 写偏序（A 读 x 写 y，B 读 y 写 x）在 SI 下允许，最终态 `{"x": 0, "y": 0}`
- d) `test_d_failed_txn_retries_successfully` — 冲突失败后重试同键成功
- e) `test_random_interleavings_match_reference_model` — 5 个随机种子 × 2000 步随机交错，
  逐步比对读结果与提交/中止结果，最终库态与参考模型一致

## 真实测试结果

环境：Python 3.14.4（向下兼容 3.11 标准库），2026-10-01 实际运行：

```
$ python3 -m unittest discover -s tests -v
test_error_codes (test_cli.TestCli.test_error_codes) ... ok
test_happy_path (test_cli.TestCli.test_happy_path) ... ok
test_retry_after_conflict_via_cli (test_cli.TestCli.test_retry_after_conflict_via_cli) ... ok
test_write_conflict_error (test_cli.TestCli.test_write_conflict_error) ... ok
test_a_first_committer_wins_on_same_key (test_engine.TestSnapshotIsolation.test_a_first_committer_wins_on_same_key) ... ok
test_b_disjoint_write_sets_both_commit (test_engine.TestSnapshotIsolation.test_b_disjoint_write_sets_both_commit) ... ok
test_c_write_skew_is_allowed (test_engine.TestSnapshotIsolation.test_c_write_skew_is_allowed) ... ok
test_conflict_detection_is_key_based_not_value_based (test_engine.TestSnapshotIsolation.test_conflict_detection_is_key_based_not_value_based) ... ok
test_d_failed_txn_retries_successfully (test_engine.TestSnapshotIsolation.test_d_failed_txn_retries_successfully) ... ok
test_read_missing_key_returns_none (test_engine.TestSnapshotIsolation.test_read_missing_key_returns_none) ... ok
test_read_only_txn_never_conflicts (test_engine.TestSnapshotIsolation.test_read_only_txn_never_conflicts) ... ok
test_read_own_writes (test_engine.TestSnapshotIsolation.test_read_own_writes) ... ok
test_snapshot_reads_never_see_later_commits (test_engine.TestSnapshotIsolation.test_snapshot_reads_never_see_later_commits) ... ok
test_random_interleavings_match_reference_model (test_random_model.TestRandomInterleaving.test_random_interleavings_match_reference_model) ... ok

----------------------------------------------------------------------
Ran 14 tests in 0.064s

OK
```
