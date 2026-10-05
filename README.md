# pipeline

动态任务图执行器（仅使用 Go 标准库）。各阶段任务在运行中可通过
`Scope.Spawn` 派生下游任务；关闭入口后，库会等待所有已接受任务及其
全部后继结束后才判定完成。

## 语义

- **关闭后排空**：`Close` 只封闭入口（`Submit` 返回 `ErrClosed`），
  已接受任务仍可派生后继；`Wait`/`Shutdown` 阻塞直到已接受任务及其
  后继全部结束。
- **完成判定基于引用计数**：接受任务时在互斥锁内原子地递增 `inflight`，
  任务结束时递减并广播条件变量；完成条件是 `closed && inflight == 0`，
  绝不通过"队列瞬时为空调度"判完成。最后一个任务在返回前派生的新任务
  仍被计数跟踪（见 `TestSpawnBeforeLastTaskCompletes`）。
- **失败停止派生**：任一任务返回错误后，记录首个错误、取消共享
  `context`，后续 `Submit`/`Spawn` 返回 `ErrCancelled`，被拒绝的任务
  不会执行。
- **事件计数守恒**：每个被接受的任务最终恰好记账一次，`Wait` 返回后
  恒有 `Stats.Submitted == Stats.Completed + Stats.Failed`。

## 用法

```go
p := pipeline.New()
_ = p.Submit(func(ctx context.Context, s *pipeline.Scope) error {
    return s.Spawn(func(ctx context.Context, s *pipeline.Scope) error {
        // 下游任务……
        return nil
    })
})
err := p.Shutdown() // Close + Wait
```

## 测试结果（实际记录）

环境：go1.27.1 linux/amd64，2026-10-05。

```
$ go test ./...
ok  	pipeline	0.115s

$ go test -race -count=5 -v ./...
--- PASS: TestSpawnBeforeLastTaskCompletes (0.06s)
--- PASS: TestDrainFollowsSuccessors (0.01s)
--- PASS: TestFailureStopsDerivation (0.02s)
--- PASS: TestSubmitAfterClose (0.00s)
--- PASS: TestStatsConservation (0.00s)
--- PASS: TestWaitBlocksUntilDrain (0.02s)
PASS
ok  	pipeline	1.581s
```

（竞态检测需可写构建缓存，本环境使用 `GOCACHE=/tmp/gocache`。）
