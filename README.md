# crdtsim — 离线协作副本的确定性因果一致性模拟

单进程确定性网络模拟 + 带 epoch 的点式版本向量（dotted version vector），
用于验证断连、重放与成员替换场景下的因果顺序判断。仅依赖 Python 3.11 标准库。

## 概念

- **Dot**：全局唯一更新标识 `(node, epoch, counter)`。
- **CausalContext**（`crdtsim/dvv.py`）：压缩因果上下文 = 每条 `(node, epoch)`
  流的连续前缀最大值 + 未连续点集。压缩不丢信息：`{1,3}` 永远不会冒充
  连续前缀 `{1,2,3}`。合并满足结合、交换、幂等。
- **Replica**（`crdtsim/store.py`）：多值寄存器存储。
  - 交付前置条件：依赖全部满足 **且** dot 在发送流上连续（缺洞即缓冲）。
  - 读取返回因果极大元素（并发时返回全部 sibling）。
  - 删除生成墓碑；被墓碑覆盖的旧写重放不会复活已删除值。
  - 墓碑仅在稳定前沿（所有**当前**成员、**当前配置版本**的 ack 的
    逐分量最小值）覆盖删除点后回收；落后配置的 ack 不推进前沿。
  - 状态合并 `merge_state` 是 CRDT join：结合、交换、幂等，崩溃后可安全重试。
  - `snapshot()` / `restore()` 提供 JSON 可序列化的快照恢复。
- **Sim**（`crdtsim/sim.py`）：确定性网络。支持延迟交付、重复交付、
  分区/愈合、退休（retire）与以新 epoch 再加入（rejoin）、反熵 `sync`。
  全部操作记入事件日志，`Sim.replay(log)` 逐事件重放并复现状态指纹。
- **enumerate**（`crdtsim/enumerate.py`）：对不超过 4 副本、12 个写事件
  枚举全部合法交付顺序（因果依赖 + 源点先发 + 源点不得先见未声明写），
  并用独立的事件 DAG 传递闭包核对每个顺序下的先后/并发与因果极大读结果；
  失败时输出贪心最小化的反例序列。

## CLI

```bash
# 执行 JSON 场景（操作列表），输出事件日志、读结果与状态指纹
python3.11 -m crdtsim.cli run scenario.json
# 重放事件日志，核对指纹
python3.11 -m crdtsim.cli replay log.json
# 枚举核对写场景 {"nodes": [...], "writes": [{"id","node","key","deps"}]}
python3.11 -m crdtsim.cli enumerate spec.json
```

场景操作：`add_node, write, delete, read, run, deliver_next, partition,
heal, retire, rejoin, sync, send_acks, broadcast_acks, gc, snapshot, restore`。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```
