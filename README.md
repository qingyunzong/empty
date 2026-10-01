# reorder — 多源传输的有序交付层

在有限内存中重排消息，按 `(stream_id, epoch)` 区分的有序交付层。
纯 Python 3.11 标准库实现，无第三方依赖。

## 设计要点

- **循环序号**（`reorder/seqnum.py`）：序号只在显式窗口 `[base, base+window)`
  内可比较（`2*window <= modulus`）。窗口外明确区分 `OLD`（窗口之后）
  与 `FUTURE`（窗口之前），禁止用普通整数大小比较回绕序号。
- **接收状态机**（`reorder/stream.py`）：消息 = 循环序号 + 分片 + 全内容哈希。
  支持乱序、重复、冲突重发；选择确认区间（`ack_ranges`）、缺口重传请求
  （`gap_requests`）、流关闭（CLOSE 帧占用一个序号）。
- **确定性背压**：窗口满时对窗口外帧返回 `BACKPRESSURE`（同状态同帧必同答），
  窗口内缺口帧始终接受；已确认未交付数据永不丢弃。
- **原子冲突拒绝**：同序号不同内容（哈希/分片数/分片负载）整体拒绝，
  证据（保留方与拒绝方）存入 `conflicts` 并写入日志，恢复后仍可见。
- **持久化一致性**（`reorder/journal.py` + `reorder/engine.py`）：日志记录
  `recv` / `assembled`（确认提交点）/ `delivered`（业务交付提交点）/
  `conflict`。确认只发生在拼装提交点，因此恢复后确认集合与输出游标必然
  一致；不一致则抛 `CorruptionError`。确认集合只保留窗口内序号（有界内存），
  窗口之后的旧序号由 OLD 分类负责去重。
- **跨 epoch**：`(stream_id, epoch)` 独立状态，旧 epoch 迟到帧返回
  `CLOSED`，不会污染新 epoch 的序号空间。

## 虚拟网络穷举校验

`reorder/vnet.py` 枚举短交付调度（BFS，含崩溃/恢复事件），把引擎输出与
结构独立的**无界参考缓冲模型**（`reorder/refmodel.py`）逐事件核对。
发现分歧时返回的即为最短失败调度（可重放 JSON）；`minimize_schedule`
可把较长失败调度贪心化简。覆盖：回绕、缺最后分片、重复关闭、
崩溃在确认前后、窗口满时补缺口、跨 epoch 迟到帧、冲突重发。

## CLI

```
python3.11 -m reorder.cli [--modulus M] [--window W] [--journal PATH] [script.jsonl]
```

JSONL 命令：`recv` / `poll` / `crash` / `recover` / `status` / `conflicts`，
每行一个命令，每行一个 JSON 响应。

## 测试

```
python3.11 -m unittest discover -s tests -v
```

最近一次运行结果见 `test-results.txt`（32 个测试全部通过）。
