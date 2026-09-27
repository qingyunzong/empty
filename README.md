# linksim

离散事件链路故障模拟器（Go 标准库，无真实网络流量）。时间为整数 tick，
事件由最小堆驱动，同 tick 事件按调度顺序处理，结果完全确定。

## 模型

- **包（Packet）**：`pending -> queued -> in_transit -> delivered`，
  故障下可能进入 `paused` 或 `dropped`。在途包与未发包（队列中）区别对待。
- **链路（Link）**：固定时延 `latency`、每 tick 发出速率 `rate`、
  delay 策略附加时延 `delayTicks`，FIFO 队列。
- **故障策略**在故障开始时固定，故障期间不变：
  - `pause`：在途包冻结（记录剩余在途时间），队列停止发出；恢复后按剩余时间继续。
  - `drop`：在途包立即丢弃；故障期间被发出的包也丢弃；队列中未发出的包不受影响。
  - `delay`：在途包与故障期间发出的包额外延迟 `delayTicks`。
- **幂等**：故障期间的重复故障事件、非故障期间的恢复事件均为无操作。
- **不复活**：已丢弃的包不参与恢复，恢复后队列按规则继续发出。

## 运行

```sh
go run .        # 演示：一条链路依次经历 pause / delay / drop 故障
go test ./...   # 单元测试
```

## 运行样例（go run .）

```
link L1: latency=3 rate=1/tick delay=+2
faults: pause@1..4 (dup drop@2 ignored), delay@6..8, drop@10..12 (dup recover@13 ignored)

packet  state      at_tick
1       delivered  8
2       delivered  9
3       dropped    10
4       dropped    10
5       dropped    10
6       dropped    10
7       dropped    10
8       delivered  16
```

## 测试结果（go test ./...）

```
=== RUN   TestNoFault
--- PASS: TestNoFault (0.00s)
=== RUN   TestPauseFreezesInTransitAndQueue
--- PASS: TestPauseFreezesInTransitAndQueue (0.00s)
=== RUN   TestDropKillsInTransitAndNewSends
--- PASS: TestDropKillsInTransitAndNewSends (0.00s)
=== RUN   TestQueuedPacketSurvivesDropFault
--- PASS: TestQueuedPacketSurvivesDropFault (0.00s)
=== RUN   TestDelayPostponesInTransit
--- PASS: TestDelayPostponesInTransit (0.00s)
=== RUN   TestDuplicateFaultAndRecoverAreIdempotent
--- PASS: TestDuplicateFaultAndRecoverAreIdempotent (0.00s)
=== RUN   TestDroppedPacketsAreNotResurrected
--- PASS: TestDroppedPacketsAreNotResurrected (0.00s)
PASS
ok  	linksim
```
