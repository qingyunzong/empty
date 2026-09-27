# vgc — MVCC 版本垃圾回收器

`vgc` 是一个基于 MVCC（多版本并发控制）的版本垃圾回收器，仅依赖
Python 3.11 标准库，提供可嵌入的 Python API 与 JSON 行协议 CLI。

## 语义

- **快照与版本**：`begin` 分配 `snapshot_ts`，`commit` 从全局单调时钟分配
  `commit_ts`。快照 `ts` 对每键可见的是 `commit_ts <= ts` 的最新版本。
- **low_watermark**：所有活跃事务 `snapshot_ts` 的最小值（无活跃事务时取
  当前时钟）。`commit_ts` 小于它且对任何活跃快照均不可见的版本可回收；
  长事务存活期间其可见版本严禁回收。
- **max_versions 预算**：每键版本数超限且存在可安全回收的版本时，回收最老
  版本；若因活跃快照钉住而无法降到预算内，`gc` 返回 `GC_DEFERRED` 状态
  （而非报错），并在 `deferred_keys` 中列出超限键。
- **时间旅行**：`as_of(ts)` 在所需版本已被回收时报 `SNAPSHOT_EXPIRED`；
  键在该时间戳尚不存在时返回 `NOT_FOUND`。

## 布局

- `vgc/core.py` — `MVCCStore`：事务、版本链、GC、统计
- `vgc/cli.py` / `vgc/__main__.py` — JSON 行协议 CLI（`python -m vgc`）
- `tests/test_vgc.py` — 验收测试与随机差分测试

## CLI 协议（JSON 行）

每行一个 JSON 请求，每行一个 JSON 响应：

```
{"op": "config", "max_versions": 2}
{"op": "begin",  "txn": "t1"}                  -> {"status": "OK", "snapshot_ts": 0}
{"op": "put",    "txn": "t1", "key": "a", "value": "v1"}
{"op": "commit", "txn": "t1"}                  -> {"status": "OK", "commit_ts": 1}
{"op": "abort",  "txn": "t1"}
{"op": "get",    "txn": "t1", "key": "a"}      -> 读自己的快照（含未提交写）
{"op": "gc"}     -> {"status": "OK"|"GC_DEFERRED", "collected": N,
                     "low_watermark": N, "deferred_keys": [...],
                     "versions_remaining": N}
{"op": "as_of",  "key": "a", "ts": 1}          -> OK / NOT_FOUND / SNAPSHOT_EXPIRED
{"op": "stats"}  -> 时钟、low_watermark、版本数、累计回收数等
```

运行：`python -m vgc [--max-versions N]`（也可用 `config` 操作动态设置）。

## 测试

命令：`python -m unittest discover -s tests -v`

覆盖验收标准：
a) 长事务持有时执行 `gc`，其可见版本保留（`LongTransactionPinningTest`）；
b) 长事务提交后 `gc` 回收版本并输出正确统计（`CollectAfterLongTxnCommitTest`）；
c) 对已过期快照 `as_of` 报 `SNAPSHOT_EXPIRED`（`SnapshotExpiredTest`）；
d) 随机操作序列（10 个种子 × 400 步，随机 `max_versions`）与保留全部版本的
   参考实现比对所有活跃快照的可见性（`RandomizedDifferentialTest`）。

### 真实测试结果（Python 3.14.4，2026-09-27 实际运行）

```
test_json_lines_protocol (test_vgc.CliTest.test_json_lines_protocol) ... ok
test_txn_lifecycle_errors (test_vgc.CliTest.test_txn_lifecycle_errors) ... ok
test_gc_collects_after_long_txn_commits (test_vgc.CollectAfterLongTxnCommitTest.test_gc_collects_after_long_txn_commits) ... ok
test_gc_preserves_versions_visible_to_long_txn (test_vgc.LongTransactionPinningTest.test_gc_preserves_versions_visible_to_long_txn) ... ok
test_deferred_while_pinned_then_ok (test_vgc.MaxVersionsBudgetTest.test_deferred_while_pinned_then_ok) ... ok
test_random_sequences (test_vgc.RandomizedDifferentialTest.test_random_sequences) ... ok
test_as_of_expired_snapshot (test_vgc.SnapshotExpiredTest.test_as_of_expired_snapshot) ... ok
test_cli_reports_snapshot_expired (test_vgc.SnapshotExpiredTest.test_cli_reports_snapshot_expired) ... ok

----------------------------------------------------------------------
Ran 8 tests in 0.025s

OK
```
