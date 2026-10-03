# dvv — 带 epoch 的点式版本向量与确定性网络模拟

离线协作副本的因果一致性内核：单进程确定性网络模拟、点式版本向量
（dotted version vector with epochs）、多值并发保留、墓碑与稳定前沿 GC、
成员退休/再加入、快照恢复，以及交付顺序的穷举校验器。仅依赖 Python 3.11
标准库。

## 核心概念

- **Dot** `(node, epoch, counter)`：每次更新的全局唯一标识。
- **CausalContext**（`dvv/context.py`）：按 `(node, epoch)` 存储连续前缀 +
  无序散点的压缩因果上下文。缺洞在结构上无法冒充连续前缀；`merge` 满足
  结合、交换、幂等（join 半格），`meet` 用于稳定前沿。
- **Event**（`dvv/event.py`）：携带自身因果上下文（含自身 dot）的更新；
  依赖 = 上下文减去自身 dot，依赖未满足前只能缓冲，不能交付。
- **Node**（`dvv/node.py`）：副本状态。读取返回因果极大的存活版本（多值）；
  删除生成墓碑，被墓碑支配的迟到/重放旧写直接丢弃（不复活）；墓碑仅在
  所有当前成员于当前配置版本下确认的稳定前沿覆盖删除点后回收；落后配置
  的确认不推进稳定前沿。`snapshot()`/`restore()` 支持崩溃恢复。
- **Network**（`dvv/network.py`）：确定性模拟。支持本地写、延迟交付
  （`delay` + `advance`）、重复交付（`duplicates`）、分区/愈合、成员退休
  （新配置版本）、再以新 epoch 加入、快照/恢复、`resync` 恢复合并。
  所有操作记入可重放事件日志：`Network.replay(log)` 逐操作重放后
  `digest()` 完全一致。
- **enumcheck**（`dvv/enumcheck.py`）：对 ≤4 副本、≤12 事件，用独立计算的
  事件 DAG 传递闭包（Warshall）核对先后/并发，BFS 枚举合法交付序列并按
  （已交付集合, 状态摘要）去重；`redeliver=True` 额外注入重放流量。失败时
  输出最短反例交付序列。

## CLI

```sh
python3.11 -m dvv examples/partition_merge.json   # 运行脚本，输出结果+日志+摘要
python3.11 -m dvv --replay run.json               # 重放日志并校验摘要
python3.11 -m dvv --check examples/partition_merge.json  # 穷举校验事件 DAG
```

脚本为 `{"ops": [...]}`，操作包括 `add_node/put/delete/read/ack/partition/
heal/deliver/run/advance/resync/snapshot/restore/gc/retire/rejoin`。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：缺洞向量、合并半格性质、并发多值、删除后旧写重放、退休再加入、
因果缺洞阻塞、合并中崩溃恢复、稳定前沿误用（过期确认/退休成员确认/
墓碑过早回收 + 重放复活的最短反例）、4 副本 12 事件穷举校验、CLI 端到端。
