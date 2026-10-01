# vgc — MVCC 版本垃圾回收器

`vgc` 是一个基于 MVCC（多版本并发控制）的版本垃圾回收器，使用 Python 3.11+
标准库实现（开发环境为 Python 3.14），无任何第三方依赖。

## 语义

- **low_watermark**：全局最老活跃快照时间戳。`commit_ts` 严格小于它、且对任何
  活跃快照均不可见、且不是该键最新版本的版本可被回收。
- **长事务保护**：长事务（活跃快照）存活期间，其可见版本严禁被回收。
- **max_versions 预算**：每键版本数超出预算时，在不影响活跃快照的前提下回收
  最老版本；若无可回收版本（剩余版本仍被快照保护或不低于水位线），`gc` 返回
  `GC_DEFERRED` 状态而非报错。
- **时间旅行**：`as_of(ts)` 查询所需版本已被回收时报 `SNAPSHOT_EXPIRED`。

## CLI（JSON 行协议）

```bash
python3 -m vgc --max-versions 3
```

从 stdin 每行读入一个 JSON 命令，向 stdout 每行输出一个 JSON 响应：

| 命令 | 响应 |
| --- | --- |
| `{"op":"begin","txn":"t1"}` | `{"ok":true,"snapshot_ts":N}` |
| `{"op":"put","txn":"t1","key":"k","value":V}` | `{"ok":true}` |
| `{"op":"commit","txn":"t1"}` | `{"ok":true,"commit_ts":N}` |
| `{"op":"gc"}` | `{"ok":true,"status":"GC_OK"\|"GC_DEFERRED","reclaimed":N,"low_watermark":N,"deferred_keys":[...]}` |
| `{"op":"as_of","ts":N,"key":"k"}` | `{"ok":true,"found":bool,"value":V}` 或 `{"ok":false,"error":"SNAPSHOT_EXPIRED",...}` |
| `{"op":"get","key":"k"}` | `{"ok":true,"found":bool,"value":V}` |
| `{"op":"stats"}` | `{"ok":true,"stats":{...}}` |

示例：

```console
$ printf '%s\n' '{"op":"begin","txn":"t1"}' '{"op":"put","txn":"t1","key":"a","value":1}' \
    '{"op":"commit","txn":"t1"}' '{"op":"begin","txn":"t2"}' '{"op":"put","txn":"t2","key":"a","value":2}' \
    '{"op":"commit","txn":"t2"}' '{"op":"gc"}' '{"op":"as_of","ts":1,"key":"a"}' \
    | python3 -m vgc --max-versions 1
{"ok": true, "snapshot_ts": 0}
{"ok": true}
{"ok": true, "commit_ts": 1}
{"ok": true, "snapshot_ts": 1}
{"ok": true}
{"ok": true, "commit_ts": 2}
{"ok": true, "status": "GC_OK", "reclaimed": 1, "low_watermark": 2, "deferred_keys": []}
{"ok": false, "error": "SNAPSHOT_EXPIRED", "key": "a", "ts": 1}
```

## 库用法

```python
from vgc import MVCCStore, SnapshotExpired

store = MVCCStore(max_versions=3)
store.begin("t1"); store.put("t1", "k", "v1"); store.commit("t1")
snap = store.begin("t_long")          # 长事务快照
store.begin("t2"); store.put("t2", "k", "v2"); store.commit("t2")
store.gc()                            # t_long 可见的版本被保留
assert store.as_of(snap, "k") == "v1"
```

## 测试

```bash
python3 -m unittest discover -s tests -v
```

验收覆盖：

- **a)** 长事务持有时执行 `gc`，其可见版本保留（`test_a_...`）；
- **b)** 长事务提交后 `gc` 回收版本并输出正确统计（`test_b_...`）；
- **c)** 对已过期快照 `as_of` 报 `SNAPSHOT_EXPIRED`（`test_c_...`）；
- **d)** 10 个随机种子 × 600 步随机操作序列，与保留全部版本的参考实现
  逐步比对所有活跃快照的可见性（`test_d_...`）。

## 真实测试结果

在本仓库交付前实际运行（Python 3.14.4，Linux）：

```console
$ python3 -m unittest discover -s tests -v
test_errors_are_json_lines (test_cli.CliTest.test_errors_are_json_lines) ... ok
test_full_session (test_cli.CliTest.test_full_session) ... ok
test_a_gc_preserves_versions_visible_to_long_transaction (test_vgc.LongTransactionTest.test_a_gc_preserves_versions_visible_to_long_transaction) ... ok
test_b_gc_reclaims_after_long_transaction_commits (test_vgc.LongTransactionTest.test_b_gc_reclaims_after_long_transaction_commits) ... ok
test_budget_enforced_when_no_snapshots (test_vgc.MaxVersionsBudgetTest.test_budget_enforced_when_no_snapshots) ... ok
test_deferred_when_budget_cannot_be_met (test_vgc.MaxVersionsBudgetTest.test_deferred_when_budget_cannot_be_met) ... ok
test_d_random_ops_match_reference_for_all_active_snapshots (test_vgc.RandomizedComparisonTest.test_d_random_ops_match_reference_for_all_active_snapshots) ... ok
test_as_of_unknown_key_is_not_expired (test_vgc.SnapshotExpiredTest.test_as_of_unknown_key_is_not_expired) ... ok
test_c_as_of_reports_snapshot_expired_after_gc (test_vgc.SnapshotExpiredTest.test_c_as_of_reports_snapshot_expired_after_gc) ... ok

----------------------------------------------------------------------
Ran 9 tests in 1.290s

OK
```

注：本环境只有 `python3` 命令（无 `python` 别名）；若环境提供 `python`，
`python -m unittest discover -s tests -v` 等价。

## 代码结构

- `vgc/core.py` — MVCC 存储引擎与 GC 算法（`MVCCStore`）。
- `vgc/cli.py` — JSON 行协议 CLI（`python3 -m vgc`）。
- `tests/test_vgc.py` — 验收测试 a–d 及预算/GC_DEFERRED 测试。
- `tests/test_cli.py` — CLI 端到端测试（子进程驱动）。
