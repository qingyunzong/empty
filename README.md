# PN-Counter with Tombstone Removal

Python 3.11 标准库实现，无任何第三方依赖。

## 语义

- 集群最多 10 个节点；每个节点在每个副本的 P/N 向量中占一个槽位。
- `inc/dec(node, k)`：仅活节点可写，`k` 必须为正整数，否则 `BAD_DELTA`。
- `value = sum(P) - sum(N)`，包含已移除节点在移除前已被观察到的贡献。
- `remove_node(n)`：需多数活节点同意（模拟为其余活节点全部投赞成票，
  因此至少需要 3 个活节点才能移除一个；不足则 `NO_MAJORITY`）。
  移除后 n 的写返回 `REMOVED`，但其墓碑副本保留，历史增量仍可被 merge。
- `merge` 为逐槽位取 max：交换、结合、幂等；绝不因移除而丢弃
  移除前因果已知的增量。墓碑节点不可复活。
- 同 ID rejoin 被拒绝：对已退役 ID 的成员操作返回 `ID_RETIRED`，
  写操作返回 `REMOVED`；新节点必须使用新 ID（首次写即隐式加入，从 0 开始）。

## 错误码

`BAD_DELTA`（k≤0 或非整数）、`REMOVED`（写已移除节点）、
`ID_RETIRED`（对已退役 ID 的成员操作）、`NO_MAJORITY`、`NOT_FOUND`、
`TOO_MANY_NODES`、`BAD_ARGS`、`BAD_COMMAND`。

## CLI

`python3 cli.py` 从 stdin 读 JSON 行，每行输出一个 JSON 响应：

```
{"cmd":"inc","node":"A","k":3}     -> {"ok":true,"value":3}
{"cmd":"dec","node":"A","k":2}     -> {"ok":true,"value":1}
{"cmd":"remove","node":"A"}        -> {"ok":true}
{"cmd":"merge","dst":"A","src":"B"}-> {"ok":true,"value":V}
{"cmd":"value","node":"A"}         -> {"ok":true,"value":V}
```

任一行出错则输出 `{"ok":false,"error":CODE}`，继续处理后续行，
进程最终以退出码 8 结束；全部成功退出码为 0。

## 测试

```
python -m unittest discover -s tests -v
```

- `tests/test_model.py`：merge 三性、BAD_DELTA、多数派、墓碑、ID 退役等单元测试。
- `tests/test_acceptance.py`：验收 A（≤6 节点 ≤25 操作、随机与穷举 merge 序，
  对照事件溯源参考矩阵）、B（迟到旧增量仍计入）、C（移除后新写拒绝且状态不变）、
  D（同 ID rejoin 拒绝、新 ID 从 0 开始）。
- `tests/test_cli.py`：CLI 协议与退出码。
