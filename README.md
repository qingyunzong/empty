# si — 快照隔离事务引擎

`si` 是一个基于 MVCC 的快照隔离（Snapshot Isolation）事务引擎，纯 Python 标准库实现（兼容 Python 3.11+），附带 JSON 行协议 CLI。

## 语义

1. **一致性快照**：事务 `begin` 时获取快照点，所有读操作基于该快照，读永不阻塞。
2. **First-committer-wins**：提交时若写集中任一键被其它事务在快照点之后提交修改，整个事务以 `WRITE_CONFLICT` 失败，且不产生任何效果。
3. **基于键集合的冲突检测**：只比较键是否被写过，不比较值（写相同值同样冲突）。
4. **可安全重试**：冲突失败的事务已被彻底中止，可用新事务安全重试同样的工作。

其它性质：read-your-own-writes；未提交写对其它事务不可见；`abort` 丢弃全部缓冲写。写偏序（write skew）在本语义下被允许（两个事务写集不相交即可同时提交）。

## 布局

- `si/engine.py` — MVCC 引擎核心（`Engine`、`WriteConflictError` 等）
- `si/cli.py` — JSON 行协议 CLI
- `si/__main__.py` — `python -m si` 入口
- `tests/` — 单元、验收与随机模型比对测试

## CLI 协议

每行一个 JSON 命令（stdin），每行一个 JSON 响应（stdout）。事务命令带 `txn` 字段。

```json
{"cmd": "begin",  "txn": "t1"}                        -> {"ok": true, "snapshot": 0}
{"cmd": "write",  "txn": "t1", "key": "x", "value": 1} -> {"ok": true}
{"cmd": "read",   "txn": "t1", "key": "x"}            -> {"ok": true, "value": 1}
{"cmd": "commit", "txn": "t1"}                        -> {"ok": true, "commit_ts": 1}
{"cmd": "abort",  "txn": "t1"}                        -> {"ok": true}
{"cmd": "dump"}                                       -> {"ok": true, "state": {"x": 1}}
```

错误以对象返回，CLI 不因坏输入崩溃：

```json
{"error": "WRITE_CONFLICT", "conflicts": ["x"]}
{"error": "UNKNOWN_TXN", "txn": "ghost"}
{"error": "BAD_JSON", "detail": "..."}
{"error": "BAD_COMMAND", "cmd": "..."}
{"error": "BAD_REQUEST", "detail": "..."}
```

### 示例

```console
$ python3 -m si
{"cmd": "begin", "txn": "a"}
{"ok": true, "snapshot": 0}
{"cmd": "begin", "txn": "b"}
{"ok": true, "snapshot": 0}
{"cmd": "write", "txn": "a", "key": "x", "value": 1}
{"ok": true}
{"cmd": "write", "txn": "b", "key": "x", "value": 2}
{"ok": true}
{"cmd": "commit", "txn": "a"}
{"ok": true, "commit_ts": 1}
{"cmd": "commit", "txn": "b"}
{"error": "WRITE_CONFLICT", "conflicts": ["x"]}
```

## 测试

```console
$ python -m unittest discover -s tests -v
```

（本环境中 `python` 不在 PATH，实际使用 `python3` / `python3.11`。）

覆盖验收标准：

- **a)** `test_same_key_first_committer_wins` — 同键两事务，先提交者成功，后者 `WRITE_CONFLICT` 且无效果
- **b)** `test_disjoint_write_sets_both_commit` — 不相交写集两事务均成功
- **c)** `test_write_skew_is_allowed` — 写偏序（A 读 x 写 y，B 读 y 写 x）两事务均提交，终态 `{"x": 200, "y": 100}`
- **d)** `test_retry_after_conflict_succeeds` — 冲突失败后以新事务重试同键成功
- **e)** `test_random_interleavings_match_reference_model` — 4 个随机种子 × 2000 步随机交错，逐步校验读结果，终态与串行参考模型（按提交顺序回放写集）一致

## 真实测试结果

2026-10-01 在本环境实际运行：

```console
$ python3.11 -m unittest discover -s tests -v
...
Ran 16 tests in 2.552s

OK
```

Python 3.11.16 与 Python 3.14.4 下均 16/16 通过（含 4 种子 × 2000 步随机比对）。
