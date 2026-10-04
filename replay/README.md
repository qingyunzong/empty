# replay — 滑动窗口防重放认证库

仅使用 Go 标准库（`math/big`、`sync`）。

## 设计

- 每个客户端一个 `Window`：宽度 W 的位图（`big.Int`），bit i 对应计数器 `highest - i`。
- 计数器为任意精度整数（`*big.Int`），天然支持超过 2^64 / 2^128 的序列。
- 窗口内乱序到达：首次接受并置位；重复（位已置）拒绝；落后于窗口拒绝。
- 前跳：位移 < W 时左移位图；位移 >= W 时清空全部旧位，仅标记新计数器。
- `Registry.Authenticate` 先验签，失败返回 `ErrBadSignature`，窗口保持不变（不推进、不记录）。
- `Registry` 持有互斥锁串行化窗口更新：并发相同请求只成功一次。

## 测试

- `TestAgainstSetModel`：集合模型（已接受计数器集合 + 最高值）作为参照，
  对 W=1/8/64/4096 各跑 20000 步随机序列（含重复、窗口内乱序、跨 2^64/2^128 跳跃），
  逐步比对接受/拒绝决策与最终 highest。
- `TestBigIntBoundaries`：2^64±1、2^64、2^128 等边界，窗口边缘（diff = W-1 接受、W 拒绝）。
- `TestConcurrentIdenticalRequests`：128 个 goroutine 同一请求，恰好 1 次成功。
- `TestConcurrentMixedRequests`：256 个 goroutine 混合重复请求，无重复接受，重放批次全军覆没。
- `TestBadSignatureDoesNotAdvanceWindow`：伪造请求不推进 highest、不记录计数器。
- `TestPerClientIsolation` / `TestInvalidCounters`。

## 实际运行结果（go1.27.1 linux/amd64）

```
$ go test ./... -count=1 -v
=== RUN   TestAgainstSetModel
=== RUN   TestAgainstSetModel/W=1
=== RUN   TestAgainstSetModel/W=8
=== RUN   TestAgainstSetModel/W=64
=== RUN   TestAgainstSetModel/W=4096
--- PASS: TestAgainstSetModel (0.06s)
    --- PASS: TestAgainstSetModel/W=1 (0.01s)
    --- PASS: TestAgainstSetModel/W=8 (0.01s)
    --- PASS: TestAgainstSetModel/W=64 (0.01s)
    --- PASS: TestAgainstSetModel/W=4096 (0.02s)
=== RUN   TestBigIntBoundaries
--- PASS: TestBigIntBoundaries (0.00s)
=== RUN   TestConcurrentIdenticalRequests
--- PASS: TestConcurrentIdenticalRequests (0.00s)
=== RUN   TestConcurrentMixedRequests
--- PASS: TestConcurrentMixedRequests (0.00s)
=== RUN   TestBadSignatureDoesNotAdvanceWindow
--- PASS: TestBadSignatureDoesNotAdvanceWindow (0.00s)
=== RUN   TestPerClientIsolation
--- PASS: TestPerClientIsolation (0.00s)
=== RUN   TestInvalidCounters
--- PASS: TestInvalidCounters (0.00s)
PASS
ok  	replay	0.062s

$ go test ./... -count=1 -race
ok  	replay	1.413s
```

全部通过；`go vet` 与 `gofmt` 无告警。
