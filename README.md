# vclock — 离散事件核心与协议会话

纯 Python 标准库实现（兼容 Python 3.11+），无第三方依赖。

## 组成

- `vclock/core.py` — 离散事件核心
  - `VirtualClock`：整数 tick 虚拟时钟，只增不减
  - 最小堆事件队列，堆键为 `(tick, prio, seq)`：`seq` 为注册序号
  - `schedule(tick, prio, fn) -> Handle`：注册事件；`tick < now` 抛 `ClockError`
  - `cancel(handle) -> bool`：取消未执行事件返回 `True`；句柄已执行/已取消/不存在返回 `False`，绝不抛错
  - `run_until(t)`：执行所有 `tick <= t` 的事件后把时钟推进到 `t`；`t < now` 抛 `ClockError`
- `vclock/protocols.py` — 两个互相隔离的协议会话
  - `HeartbeatSession`：每 30 tick 发 PING，60 tick 无 PONG 转 `DEAD`（参数可调）
  - `StopAndWaitARQ`：停等 ARQ，超时重传，超过 `max_retries` 转 `FAILED`，全部 ACK 后 `DONE`
- `vclock/scenario.py` / `vclock/__main__.py` — 场景运行器与 CLI

## 语义保证

1. 同 tick 事件按 `prio` 升序执行；同 `prio` 按注册顺序（FIFO）执行。
2. 事件回调内可注册同 tick 新事件，并在本 tick 内执行（堆动态排空）。
3. `cancel` 已执行或不存在的句柄返回 `False`，不抛错。
4. 时钟只增：`schedule` 过去时刻、`run_until` 倒退均抛 `ClockError`。
5. 会话状态完全隔离：一个会话 `DEAD`/`FAILED` 不影响另一会话。

## CLI

```bash
python -m vclock run scenario.json   # 事件轨迹以 JSONL 输出到 stdout
```

场景文件格式（见根目录 `scenario.json` 示例）：

```json
{
  "until": 100,
  "events": [
    {"tick": 10, "prio": 0, "name": "evt-b",
     "spawn": [{"delay": 0, "prio": 5, "name": "evt-c"}]}
  ],
  "sessions": [
    {"type": "heartbeat", "id": "hb", "interval": 30, "timeout": 60, "pong_delay": null},
    {"type": "arq", "id": "arq", "packets": 2, "timeout": 10, "ack_delay": 2}
  ]
}
```

- `events[].spawn`：回调内在 `当前tick + delay` 注册子事件（`delay: 0` 即同 tick）。
- heartbeat 的 `pong_delay: null` 表示对端永不回 PONG（模拟链路死亡）。
- arq 的 `ack_delay: null` 表示永不回 ACK；`ack_loss: N` 表示前 N 次传输的 ACK 丢失。

## 测试

```bash
python -m unittest discover -v
```

覆盖验收场景：

- (a) 混合事件序列执行顺序与纸面优先级枚举表完全一致（`tests/test_core.py::TestOrdering`）
- (b) 回调内注册同 tick 事件断言当 tick 执行（`TestSameTickScheduling`）
- (c) 心跳丢 PONG 在 60 tick 转 `DEAD`，ARQ 会话照常 `DONE`（`TestSessionIsolation`）
- (d) `cancel` 已触发事件返回 `False`（`TestCancel`）
- 另含时钟单调性/`ClockError`、ARQ 重传与失败、CLI JSONL 轨迹等测试

### 真实测试结果（2026-09-30，Python 3.14.4 实际运行）

```
Ran 25 tests in 0.137s

OK
```

**25 通过 / 0 失败 / 0 错误**（共 25 个测试，全部通过）。
