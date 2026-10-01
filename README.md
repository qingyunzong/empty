# mvcc — 多版本键值存储

Python 3.11 标准库实现，无第三方依赖。

## 语义

- 每个版本记录 `(begin_ts, end_ts)`；提交时分配全局单调递增的 `commit_ts`。
- `snapshot` 事务在 `begin` 时刻固定快照，整个事务期间只见快照点之前已提交且未删除的版本。
- `read_committed` 事务每次读取都见当前最新已提交版本。
- `delete` 写入墓碑（tombstone）版本，不做物理删除，旧快照仍可读历史版本。
- 事务内可读己之写（含自己的墓碑）。
- 对非活跃事务（已提交/已中止/不存在）的任何操作报 `TXN_STATE` 错误。

## 接口

```python
from mvcc import MVCCStore

store = MVCCStore()
store.begin("snapshot", txn_id="t1")   # mode: "snapshot" | "read_committed"
store.put("t1", "k", "v")
store.get("t1", "k")                   # 不存在/已删除返回 None
store.delete("t1", "k")
store.commit("t1")                     # 返回 commit_ts
store.abort("t1")
```

## CLI

```
python -m mvcc.cli
```

stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果；读到不存在的键返回
`{"value": null}`；错误输出 `{"error": 码}`（如 `TXN_STATE`、`INVALID_MODE`、
`UNKNOWN_OP`、`BAD_COMMAND`）后进程继续处理后续行。

```json
{"op": "begin",  "txn": "t1", "mode": "snapshot"}   -> {"ok": true, "txn": "t1"}
{"op": "put",    "txn": "t1", "key": "a", "value": 1} -> {"ok": true}
{"op": "commit", "txn": "t1"}                       -> {"ok": true, "commit_ts": 1}
{"op": "get",    "txn": "t1", "key": "a"}           -> {"error": "TXN_STATE"}
```

## 测试

```
python -m unittest discover -s tests -v
```

覆盖验收项：

- a) 两个 snapshot 事务交错，可见性矩阵与纯 Python 参考实现
  （`tests/reference.py`，基于快照字典的独立实现）逐键比对；
- b) abort 后其写入完全不可见，且不影响此前已提交版本；
- c) 对已提交事务再次 commit 报 `TXN_STATE`；
- d) 固定种子的 1000 步随机操作与参考模型逐步比对（含错误码一致性）；
- 另有 read_committed 语义、读己之写、commit_ts 单调性、墓碑版本链、
  CLI 端到端（含错误恢复与坏 JSON 恢复）测试。

## 真实测试结果（交付前实际运行）

命令：`python -m unittest discover -s tests -v`（Python 3.14.4，代码兼容 3.11）

- 运行用例数：13
- 通过：13
- 失败：0
- 结果：OK
