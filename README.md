# nakproto — 接收方 NAK 可靠交付协议仿真

纯 Python 3.11+ 标准库实现（无第三方依赖）。发送方持续发送递增序号帧
（无 ACK），接收方检测序号缺口后发送 NAK 请求重传；发送方保留最近
`W = 8` 帧的环形缓冲用于重传。虚拟时钟以 tick 为单位推进。

## 语义规则

- **缺口缓存**：缺口补齐前，后续到达的帧只缓存不交付。
- **NAK 防抖**：对同一缺口（同一缺失序号）每 `20` tick 至多发一次 NAK。
- **RANGE_ERR**：NAK 请求的帧已滑出发送方环形缓冲时，发送方回
  RANGE_ERR，接收方转入 `FAILED` 并停止交付（交付序列冻结）。
- **重复 NAK**：发送方对同一序号的重复 NAK 幂等处理，不产生副作用。
- **交付**：严格递增、去重；`seq < expected` 的迟到/重复帧直接丢弃，
  不触发 NAK。

## 时序模型（每 tick 的处理顺序）

1. 处理本 tick 计划到达的帧/控制消息（重传帧、RANGE_ERR、重复副本）。
2. 发送方发送新帧 `seq = t`（`t <= frames`），进入环形缓冲；除非脚本
   丢弃，否则接收方在同一 tick 处理它。
3. 接收方处理中产生的 NAK 由发送方立即应答：RETX（帧仍在缓冲）或
   RANGE_ERR（已滑出）；应答于 `t+1` 到达接收方。

## 参考枚举时序表（验收场景 a：`frames=10, drop=[3]`）

| tick | 事件 |
|-----:|------|
| 1 | 发送 1 → 交付 1 |
| 2 | 发送 2 → 交付 2 |
| 3 | 发送 3 → **丢失** |
| 4 | 发送 4 → 检测到缺口(expect 3, got 4)，缓存 4，**NAK(3) @ tick 4**；发送方 RETX 3（tick 5 到达） |
| 5 | 重传 3 到达 → 交付 3，排空缓存交付 4；发送 5 → 交付 5 |
| 6–10 | 发送并交付 6, 7, 8, 9, 10 |

交付序列 `1..10`，交付时刻 `[1,2,5,5,5,6,7,8,9,10]`，NAK 日志
`[{tick: 4, seq: 3}]`。测试 `ScenarioAFrame3Lost` 逐项断言该表。

## 验收场景对应

- **a)** 帧 3 丢失：NAK 于检测时刻（tick 4）发出，重传后 tick 5 连续
  交付 3,4,5，与上表一致。
- **b)** 同一缺口（重传也丢失）：NAK 仅出现在 tick 4 与 tick 24，
  20 tick 窗口内仅 1 个 NAK。
- **c)** 丢失帧滑出窗口（W=8 < 防抖 20，第二次 NAK 时 seq 3 已滑出）：
  tick 24 RANGE_ERR → tick 25 FAILED，交付冻结为 `[1, 2]`。
- **d)** 乱序但无缺口（迟到重复副本，`seq < expected`）：零 NAK，
  交付严格递增去重。

## 脚本格式（loss_script.json）

```json
{
  "frames": 10,
  "drop": [3],
  "drop_retx": [],
  "duplicate": []
}
```

- `frames`：总帧数，序号 `1..frames`，每 tick 一帧。
- `drop`：首次发送即丢失的序号。
- `drop_retx`：重传也丢失的序号。
- `duplicate`：首次到达 2 tick 后再到达一份重复副本的序号。

所有序号列表必须**严格递增**，否则抛 `ConfigError`（CLI 退出码 2）。

## CLI

```bash
python -m nakproto run loss_script.json
```

输出 JSON：`state`（OK/FAILED/INCOMPLETE）、`delivered`（交付序列）、
`delivery_ticks`、`nak_log`（NAK 日志）、`events`（完整事件流）。

## 测试

```bash
python -m unittest discover -v
```

### 真实测试结果（2026-09-30，Python 3.14.4 实际运行）

```
Ran 21 tests in 0.093s

OK
```

21 个测试全部通过，覆盖：场景 a（4 项断言，含参考时序表）、场景 b
（防抖）、场景 c（RANGE_ERR→FAILED 且交付冻结）、场景 d（零 NAK）、
重复 NAK 幂等、ConfigError 校验（非递增/越界/非法 frames）与 CLI
（正常输出、ConfigError 退出码 2、用法错误）。

## 代码结构

- `nakproto/sim.py` — 协议核心：`Sender`（环形缓冲 W=8）、`Receiver`
  （缺口检测、NAK 防抖 20 tick、有序交付）、`run_simulation`（tick 循环）。
- `nakproto/script.py` — 脚本解析与校验（`ConfigError`）。
- `nakproto/__main__.py` — CLI 入口。
- `tests/test_protocol.py` — 全部验收测试。
