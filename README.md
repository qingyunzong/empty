# GBN 协议模拟器（回退N）

纯 Python 3.11+ 标准库实现的 Go-Back-N 可靠传输协议模拟：**窗口 N=4，序号空间 8**，
虚拟时钟按 tick 推进，信道可丢包、乱序（由延迟产生）、延迟、损坏，故障由 trace 脚本注入。

## 协议语义

- **接收方**：只接受期望序号的帧，其余（乱序/损坏）一律丢弃并重发上一个累计 ACK；
  尚未收到任何帧时不发 ACK。
- **发送方**：收到累计 ACK `k` 则窗口滑动至 `k+1`（模 8）；重复/过期 ACK 直接忽略。
- **定时器**：仅最早未确认帧持有定时器；超时重传窗口内全部未确认帧并重启定时器。
- **序号回绕**：所有序号比较使用模运算 `(seq - base) % 8`，`7 → 0` 回绕正确。
- **窗口满**：`send()` 返回 `False`，不阻塞。

## 目录结构

- `gbn/protocol.py` — 模运算比较、`Sender`、`Receiver`
- `gbn/channel.py` — 虚拟时钟信道与故障注入规则（drop / corrupt / delay）
- `gbn/simulator.py` — tick 驱动的事件循环（交付 → 超时 → 发送 → 入信道）
- `gbn/__main__.py` — CLI 入口
- `tests/test_gbn.py` — 单元测试与验收场景
- `examples/trace.json` — 示例故障注入脚本

## CLI 用法

```bash
python -m gbn simulate trace.json            # 输出交付序列（JSON）
python -m gbn simulate trace.json --events   # 同时输出完整事件序列
```

trace 脚本格式：

```json
{
  "frames": 12,
  "timeout": 10,
  "events": [
    {"action": "drop",    "kind": "data", "seq": 2, "occurrence": 1},
    {"action": "delay",   "kind": "data", "seq": 6, "occurrence": 1, "by": 2},
    {"action": "corrupt", "kind": "ack",  "seq": 4, "occurrence": 1}
  ]
}
```

- `frames`：整数（载荷自动为 `0..n-1`）或载荷数组。
- `action`：`drop`（丢弃）、`corrupt`（损坏）、`delay`（额外延迟 `by` 个 tick，可制造乱序）。
- `kind`：`data` 或 `ack`；`occurrence` 表示该 (kind, seq) 的第几次发送（重传计为新的一次）。

示例（`examples/trace.json`：帧 2 首次发送被丢弃、帧 6 延迟、ACK 4 损坏）：

```
$ python -m gbn simulate examples/trace.json
[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
```

## 测试

```bash
python -m unittest discover -v
```

覆盖验收场景：

- **a)** 无丢失传 12 帧，事件序列与参考暴力枚举（逐帧模拟期望值）完全一致；
- **b)** 帧 2 丢失 → 帧 3、4 被接收方丢弃并重发上一累计 ACK → 超时重传窗口，
  交付序列严格递增无重复；
- **c)** 传 20 帧序号回绕两次，断言无死锁；另有跨回绕边界的丢包恢复用例；
- **d)** 注入损坏 ACK，断言窗口不滑动（超时前无任何 `window-slide` 事件），
  最终靠超时重传完成交付。

### 真实测试结果

环境：Python 3.14.4（代码仅使用 3.11 标准库）。实际运行输出：

```
test_events_match_bruteforce_reference (tests.test_gbn.TestCleanChannel) ... ok
test_simulate_command_outputs_delivered_sequence (tests.test_gbn.TestCli) ... ok
test_corrupt_ack_does_not_slide_window (tests.test_gbn.TestCorruptAck) ... ok
test_lost_frame_triggers_go_back_n (tests.test_gbn.TestFrameLoss) ... ok
test_accepts_only_expected_sequence (tests.test_gbn.TestReceiverUnit) ... ok
test_corrupt_frame_discarded (tests.test_gbn.TestReceiverUnit) ... ok
test_delayed_frame_causes_reorder_and_recovery (tests.test_gbn.TestReorder) ... ok
test_cumulative_ack_slides_window_across_wrap (tests.test_gbn.TestSenderUnit) ... ok
test_send_returns_false_when_window_full (tests.test_gbn.TestSenderUnit) ... ok
test_stale_ack_ignored (tests.test_gbn.TestSenderUnit) ... ok
test_timeout_retransmits_whole_window (tests.test_gbn.TestSenderUnit) ... ok
test_seq_distance (tests.test_gbn.TestSequenceArithmetic) ... ok
test_wrap_around_comparison (tests.test_gbn.TestSequenceArithmetic) ... ok
test_loss_across_wrap_boundary (tests.test_gbn.TestWrapAround) ... ok
test_twenty_frames_no_deadlock (tests.test_gbn.TestWrapAround) ... ok

----------------------------------------------------------------------
Ran 15 tests in 0.039s

OK
```
