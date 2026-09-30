# Selective Repeat (SR) 协议模拟器

Python 3.11 标准库实现的选择重传协议：窗口 `N=4`、序号空间 `M=8`，
每帧独立虚拟定时器，超时仅重传该帧；接收方缓存乱序帧、逐个 ACK、按序交付。

## 目录结构

- `sr/protocol.py` — 协议核心：`Sender` / `Receiver` / 参数约束校验
- `sr/simulator.py` — 虚拟时钟 + 信道模拟器（`advance`、丢帧、投递）
- `sr/__main__.py` — CLI：`python -m sr run trace.json`
- `tests/test_sr.py` — unittest 验收测试（场景 a–d 及语义 1–4）
- `examples/trace.json` — 场景 (a) 的示例 trace

## 参数约束论证：为什么必须 N ≤ M/2

接收窗口为 `[rcv_base, rcv_base+N)`，已交付帧的重复区域为
`[rcv_base-N, rcv_base)`。接收方仅凭线上序号（mod M）区分
"窗口内新帧"与"已交付帧的重复"，两个区间在模 M 意义下不得重叠，
因此要求 `2N ≤ M`，即 `N ≤ M/2`。

`N=4, M=8` 恰好满足（两区间各 4 个序号，无缝衔接）；`N=5, M=8`
时旧帧的重复会别名到尚未接收的序号上，无法区分，构造时抛 `ValueError`：

```python
>>> from sr import Simulator
>>> Simulator(window_size=5, seq_space=8)
ValueError: invalid SR parameters: window size N=5 exceeds half the sequence space M=8 ...
```

## 语义

1. 接收窗口外的帧直接丢弃（不缓存、不 ACK）。
2. 重复帧（落在 `[rcv_base-N, rcv_base)`）重发 ACK，但不重复交付。
3. 发送方仅在收到窗口下沿（base）的 ACK 时才滑动窗口；其余 ACK
   只标记该帧并取消其定时器。
4. 虚拟时钟 `advance(t)` 按最早到期的定时器依次触发；同一 tick
   多个定时器到期时按序号升序触发。超时仅重传该帧并重置其自身定时器。

## CLI

```bash
python -m sr run examples/trace.json
# {"delivered": ["f0", "f1", "f2", "f3"], "retransmissions": 1}
```

输出 JSON：`delivered` 为按序交付序列，`retransmissions` 为重传计数。

### Trace 格式

```json
{
  "window_size": 4,
  "seq_space": 8,
  "timeout": 10,
  "events": [
    {"op": "send", "data": "f0"},
    {"op": "lose", "seq": 1},
    {"op": "deliver", "seq": 0},
    {"op": "lose_ack", "seq": 2},
    {"op": "deliver_ack", "seq": 0},
    {"op": "advance", "t": 10}
  ]
}
```

| op | 含义 |
|---|---|
| `send` | 应用层交付数据，发送方发帧入信道（窗口满则报错） |
| `advance` | 虚拟时钟前进 `t`，触发到期定时器（重传入信道） |
| `lose` / `deliver` | 丢弃 / 投递信道中指定序号的帧 |
| `lose_ack` / `deliver_ack` | 丢弃 / 投递信道中指定序号的 ACK |

## 测试

```bash
python -m unittest discover -v
```

真实运行结果（本仓库最终状态）：**Ran 15 tests — OK（15/15 通过）**。

覆盖验收场景：

- (a) 仅帧 1 丢失：帧 2、3 被缓存，帧 1 超时重传后 1、2、3 一次性交付，
  逐步与参考枚举表 `REFERENCE_TABLE` 比对（`TestScenarioAFrameLoss`）。
- (b) 同帧两次到达：重发 ACK，交付去重（`TestScenarioBDuplicate`）。
- (c) 两个定时器同 tick 到期：按序号升序触发（`TestScenarioCSameTickTimers`）。
- (d) `N=5, M=8` 构造抛 `ValueError`（`TestParamValidation`）。
- 另含窗口外帧丢弃、仅下沿 ACK 滑动窗口、逐帧独立定时器、CLI 端到端等测试。
