# msdeliv — 多源有序交付层

按 `(stream_id, epoch)` 区分的有序交付层，Python 3.11 标准库实现，无第三方依赖。

## 特性

- **循环序号**：序号只在显式窗口内可比较（`msdeliv/seqnum.py`）。相对下一期望序号的
  前向距离 `d`：`d < window` 在窗口内；`d >= mod - window` 明确为旧消息；
  其余为模糊区，拒绝而非用整数大小比较回绕序号。要求 `2*window < mod`。
- **分片与内容哈希**：每个分片携带整消息内容哈希；同序号不同内容的重发被**原子拒绝**
  （不改变任何状态），并保留证据（双方哈希与载荷），证据写入日志、崩溃恢复后仍在。
- **乱序 / 重复 / 冲突重发**：乱序分片入窗缓冲；精确重复幂等；已交付序号在过去窗口内
  仍比对哈希，内容不同记为冲突。
- **选择确认与缺口重传**：`acks()` 返回相对 `next_seq` 偏移的确认区间、缺口区间和
  具体重传序号列表，避免在窗口外比较循环序号。
- **确定性背压**：乱序缓冲达到 `capacity` 时对新序号返回 `busy`（同一状态同一决策，
  不驱逐任何已确认未交付数据）；队首缺口帧（`seq == next_seq`）始终可接受，窗口满不会死锁。
- **流关闭**：`close` 消息交付后流关闭；重复关闭幂等。
- **持久化与恢复**：JSONL 日志记录接收（`recv`）、拼装完成（`assembled`）、业务交付
  提交点（`delivered`，含全局输出游标）以及冲突证据。恢复时确定性重放，确认集合与
  输出游标与崩溃前一致；已确认未交付数据恢复后照常交付（恰好一次）。
- **跨 epoch**：迟到旧 epoch 帧返回 `stale_epoch`，与窗口内旧帧区分，不污染当前状态。

## 虚拟网络对拍

`msdeliv/vnet.py` 枚举短交付顺序（排列含重复帧），把同一调度跑在真实引擎和独立的
无界参考缓冲模型（`msdeliv/refmodel.py`）上，核对交付输出一致。背压/模糊被拒的帧
由虚拟网络停驻并在状态变化时重试（模拟发送方重传）。发现分歧时
`minimize_failing` 贪心缩减为最短失败调度，可序列化为 JSON 并用
`vnet.replay_file` 或 CLI 重放。

## JSON CLI

```
python3.11 -m msdeliv.cli < commands.jsonl
```

每行一个 JSON 命令，每行输出一个 JSON 事件：

```
{"op":"new","mod":16,"window":4,"capacity":2,"log":"session.jsonl"}
{"op":"send","frame":{"stream":"s","epoch":0,"seq":0,"frag":0,"frags":1,"payload":"hi","hash":"...","close":false}}
{"op":"poll"}                 -> {"event":"delivered","outputs":[...]}
{"op":"acks","stream":"s","epoch":0}
{"op":"crash"} / {"op":"recover"}
{"op":"replay","schedule":[...],"prefix":[...]}   虚拟网络重放调度
{"op":"verify","schedule":[...]}                  与参考模型对拍；分歧时输出 minimal_schedule
```

## 测试

```
python3.11 -m unittest discover -s tests -v
```

覆盖：序号回绕、缺最后分片、重复关闭、确认前/后崩溃、窗口满时补缺口、
跨 epoch 迟到帧、冲突重发（含证据持久化）、乱序/重复/冲突调度的穷举对拍、
最短失败调度缩减与重放、CLI 端到端。

### 最近一次运行结果

```
Ran 35 tests in ~2.5s

OK
```
（35 个测试全部通过；详见提交时的实际运行记录。）
