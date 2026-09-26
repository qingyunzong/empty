# netsim — 离散事件链路仿真（Go 标准库）

整数 tick 的离散事件仿真：包、FIFO 队列、单链路。只模拟，不发真实网络流量。

## 模型语义

- 时间为整数 tick，仿真器（`sim.go`）用最小堆按 `(tick, 序号)` 处理事件；
  时间只在事件之间跳跃。
- 链路参数：`Latency`（在途 tick 数）、`Rate`（每 tick 最多出队包数）。
- 包生命周期状态（在途与未发严格区分）：
  `pending` → `queued`（未发）→ `in-transit`（在途）→ `delivered`；
  故障期间在途包可进入 `paused` 或直接 `dropped`。
- 故障在开始 tick 固化策略，作用于当时的在途包；故障期间队列停止发包：
  - `pause`：在途包冻结，记录剩余 tick；恢复后从冻结点继续。
  - `drop`：在途包立即丢弃，恢复后**不可复活**。
  - `delay(+n)`：在途包到达 tick 加固定 n；未发包不受影响。
- 恢复后队列按原规则继续（FIFO + Rate）。
- 幂等：故障中再次收到故障事件 → 忽略（首个策略不变，即使事件里策略不同）；
  健康时收到恢复事件 → 忽略。
- 仿真结束时仍未到终态的包保留 `queued` / `paused` 等状态输出。

## 运行

```sh
go test ./... -v   # 测试
go run ./cmd/netsim  # 运行样例：同一份发包/故障时序下的 pause/drop/delay 三策略
```

## 样例输出

```
scenario: fault=pause  end tick=9
  pkt 1: delivered  sent@0 delivered@7
  pkt 2: delivered  sent@1 delivered@8
  pkt 3: delivered  sent@6 delivered@9

scenario: fault=drop  end tick=9
  pkt 1: dropped    sent@0 dropped@2 (stays dropped after recovery)
  pkt 2: dropped    sent@1 dropped@2 (stays dropped after recovery)
  pkt 3: delivered  sent@6 delivered@9

scenario: fault=delay(+2)  end tick=9
  pkt 1: delivered  sent@0 delivered@5
  pkt 2: delivered  sent@1 delivered@6
  pkt 3: delivered  sent@6 delivered@9
```

时序：latency=3、rate=1；tick 0/1 释放 p1/p2，tick 2 故障（tick 3 重复故障被忽略），
tick 3 释放 p3（未发包），tick 6 恢复。
