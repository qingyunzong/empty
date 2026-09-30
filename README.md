# GBN (Go-Back-N) 协议仿真

纯 Python 3.11 标准库实现的回退 N（GBN）可靠传输协议仿真，窗口 N=4，序号空间 8，
虚拟时钟按 tick 推进，信道可按脚本注入丢包、损坏、延迟（乱序）。

## 结构

- `gbn/protocol.py` — `Sender` / `Receiver` 协议实体，模 8 序号运算
- `gbn/simulator.py` — `Environment`（虚拟时钟 + 事件队列）、`Channel`（脚本化丢包/损坏/延迟）、`run_simulation`
- `gbn/__main__.py` — CLI 入口
- `tests/test_gbn.py` — unittest 验收测试
- `examples/trace.json` — 示例轨迹（帧 2 首次传输丢失）

## 语义实现

1. 接收方只接受期望序号帧，其余丢弃并重发上一累计 ACK（`Receiver.receive_frame`）。
2. 发送方收到累计 ACK k 则滑动窗口至 k+1（`Sender.receive_ack`）；
   重复/窗口外 ACK 忽略，损坏 ACK 忽略且不滑动窗口。
3. 仅最早未确认帧持有超时定时器（版本化定时器避免串扰），超时重传窗口内全部未确认帧。
4. 序号比较统一走模运算 `seq_distance`，回绕（7→0）正确；窗口满时 `send()` 返回 `False` 不阻塞。

## CLI

```bash
python -m gbn simulate trace.json            # 输出交付序列（JSON 数组）
python -m gbn simulate trace.json --events   # 额外输出完整事件序列
```

trace.json 格式：

```json
{
  "window": 4, "seq_space": 8, "timeout": 8,
  "frame_delay": 1, "ack_delay": 1,
  "messages": [{"tick": 0, "data": 0}, ...],
  "script": {
    "drop":    [{"kind": "frame", "seq": 2, "occurrence": 1}],
    "corrupt": [{"kind": "ack",   "seq": 0, "occurrence": 1}],
    "delay":   [{"kind": "frame", "seq": 3, "occurrence": 1, "extra": 3}]
  }
}
```

`occurrence`（1 起）指定该 (kind, seq) 的第几次传输受规则影响，因此帧首次丢失后重传可送达。

示例运行（帧 2 首次传输丢失，触发 GBN 超时重传）：

```
$ python -m gbn simulate examples/trace.json
[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
```

## 测试

```bash
python -m unittest discover -v
```

覆盖验收场景：
- (a) 无丢失传 12 帧，事件序列与测试内独立的逐帧暴力参考实现完全一致；
- (b) 帧 2 丢失 → 帧 3、4 被接收方丢弃并重发上一累计 ACK，超时重传窗口 [2,3,4,5]，
  交付序列严格递增无重复；
- (c) 传 20 帧（含一次丢包），序号回绕 7→0，无死锁，交付完整有序；
- (d) 注入损坏 ACK，窗口不滑动（且从未滑到该 ACK 对应的 base=1），最终交付正确；
- 窗口满（含回绕后）`send()` 返回 `False`；累计 ACK 跨回绕滑动；CLI 端到端。

真实运行结果（Python 3.14.4，2026-09-30）：

```
test_cli_outputs_delivered_sequence (tests.test_gbn.TestCli.test_cli_outputs_delivered_sequence) ... ok
test_corrupted_ack_does_not_slide_window (tests.test_gbn.TestCorruptedAck.test_corrupted_ack_does_not_slide_window) ... ok
test_delivery_strictly_increasing_no_duplicates (tests.test_gbn.TestFrameLossGoBackN.test_delivery_strictly_increasing_no_duplicates) ... ok
test_duplicate_acks_ignored (tests.test_gbn.TestFrameLossGoBackN.test_duplicate_acks_ignored) ... ok
test_frames_3_and_4_discarded (tests.test_gbn.TestFrameLossGoBackN.test_frames_3_and_4_discarded) ... ok
test_timeout_retransmission_happened (tests.test_gbn.TestFrameLossGoBackN.test_timeout_retransmission_happened) ... ok
test_event_sequence_matches_reference (tests.test_gbn.TestNoLossMatchesReference.test_event_sequence_matches_reference) ... ok
test_cumulative_ack_slides_window_across_wrap (tests.test_gbn.TestSenderWindowFull.test_cumulative_ack_slides_window_across_wrap) ... ok
test_window_full_after_wraparound (tests.test_gbn.TestSenderWindowFull.test_window_full_after_wraparound) ... ok
test_window_full_returns_false (tests.test_gbn.TestSenderWindowFull.test_window_full_returns_false) ... ok
test_wraparound_completes (tests.test_gbn.TestWrapAroundNoDeadlock.test_wraparound_completes) ... ok

----------------------------------------------------------------------
Ran 11 tests in 0.023s

OK
```
