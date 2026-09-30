# vclock — 离散事件仿真核心

基于 Python 3.11 标准库实现的离散事件核心：整数 tick 虚拟时钟 + 最小堆事件队列，
其上复用两个相互独立的协议会话（停等 ARQ 与心跳保活）。

## 核心语义

- `schedule(tick, prio, fn, name=None) -> Handle`：注册事件；`tick < now` 抛 `ClockError`。
- `cancel(handle) -> bool`：取消待执行事件；句柄已执行或不存在时返回 `False`，不抛错。
- `run_until(t)`：执行所有 `tick <= t` 的事件；`t < now` 抛 `ClockError`；时钟只增。
- 同 tick 事件按 `prio` 升序执行，同 prio 按注册序（堆键 `(tick, prio, seq)`）。
- 事件回调内可注册同 tick 新事件，且在本 tick 内执行（最小堆自然弹出）。

## 协议会话

- `StopWaitARQ`：停等 ARQ。状态机 `IDLE -> WAIT_ACK -> DONE / FAILED`；
  ACK 超时重传，超过 `max_retries` 转 `FAILED`；`loss` 指定丢弃的第几次发送（1 起计）。
- `HeartbeatSession`：每 `interval`（默认 30）tick 发 PING；
  PING 后 `dead_after`（默认 60）tick 内无 PONG 判 `DEAD` 并停止。
- 会话仅共享时钟，状态完全隔离：一个会话 `FAILED`/`DEAD` 不影响另一会话。

## CLI

```bash
python -m vclock run scenario.json
```

将事件轨迹以 JSONL 输出到 stdout（每行一个事件），会话终态摘要输出到 stderr。
场景格式见 `vclock/scenario.py` 模块 docstring 与仓库根目录的 `scenario.json` 示例
（含混合优先级事件、回调内 spawn 同 tick 事件、命名事件 cancel、ARQ 丢包重传、
心跳丢 PONG 转 DEAD）。

## 测试

```bash
python -m unittest discover -v
```

覆盖验收场景：
a) 手工混合事件序列与纸面优先级枚举表逐项一致；
b) 回调内注册同 tick 事件断言当 tick 执行（含链式 spawn）；
c) 心跳丢 PONG 在 tick 60 转 DEAD，同时 ARQ 会话照常 DONE（及反向：ARQ FAILED 不影响心跳）；
d) cancel 已触发/不存在句柄返回 False 且不抛错；
另含时钟单调性与 `ClockError` 语义。

## 真实测试结果

- 运行环境：Python 3.14.4（代码仅使用 3.11 标准库特性）
- 命令：`python -m unittest discover -v`
- 结果：**Ran 15 tests — OK（15 通过 / 0 失败 / 0 错误）**
