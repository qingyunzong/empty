# mvcc — 多版本键值存储

纯 Python 3.11+ 标准库实现，无第三方依赖。

## 语义

- 每个已提交版本记录 `(begin_ts, end_ts)`；提交事务时分配全局单调递增的
  `commit_ts`，作为新版本的 `begin_ts` 和被覆盖版本的 `end_ts`。
- `snapshot` 事务在 `begin` 时固定快照（当前 `commit_ts`），整个事务期间
  只能看到快照时刻已提交且未被删除的版本。
- `read_committed` 事务每次读取都看到最新的已提交版本。
- `delete` 写入墓碑（tombstone）版本，不做物理删除。
- 事务内可读己之写（写操作先进入事务私有缓冲区，提交时落盘为版本）。
- `abort` 丢弃缓冲区，其写入对任何事务不可见，也不产生版本。

## API

```python
from mvcc import Store

store = Store()
t = store.begin("snapshot")          # 或 "read_committed"
store.put(t, "k", "v")
store.get(t, "k")                    # 不存在的键 / 墓碑 -> None
store.delete(t, "k")
store.commit(t)                      # 返回 commit_ts
store.abort(t)
```

错误以异常抛出，携带稳定错误码：`TXN_STATE`（对已提交/已中止事务再操作，
包括重复 commit）、`UNKNOWN_TXN`、`INVALID_MODE`。

## CLI

```
python3 -m mvcc
```

stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果；读到不存在的键返回
`{"value": null}`；出错输出 `{"error": 码}` 后进程继续。

| 命令 | 结果 |
| --- | --- |
| `{"op":"begin","mode":"snapshot"}` | `{"txn": N}` |
| `{"op":"get","txn":N,"key":K}` | `{"value": V\|null}` |
| `{"op":"put","txn":N,"key":K,"value":V}` | `{"ok": true}` |
| `{"op":"delete","txn":N,"key":K}` | `{"ok": true}` |
| `{"op":"commit","txn":N}` | `{"ok": true, "commit_ts": T}` |
| `{"op":"abort","txn":N}` | `{"ok": true}` |

## 测试

```
python3 -m unittest discover -s tests -v
```

覆盖验收项：

- a) `tests/test_snapshot_interleave.py`：两个 snapshot 事务交错，可见性
  矩阵与纯 Python 参考实现（`tests/reference.py`）逐键比对。
- b) `tests/test_abort.py`：abort 后写入完全不可见；delete 产生墓碑版本。
- c) `tests/test_txn_state.py`：对已提交事务再次 commit 报 `TXN_STATE`。
- d) `tests/test_random_model.py`：1000 步随机操作（多种子）与参考模型比对。
- CLI 协议与错误后继续处理：`tests/test_cli.py`。

## 真实测试结果

交付前实际运行 `python3 -m unittest discover -s tests -v`
（Python 3.14.4）：

- **通过：17，失败：0，错误：0**（`Ran 17 tests ... OK`）
