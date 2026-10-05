# pipeline

并发任务流水线库（仅 Go 标准库）。各阶段处理器可派生下游任务；
关闭入口后，`Wait` 等待所有已接受任务及其全部后继结束。

## 设计要点

- **完成判定**：基于在途任务计数（`sync.WaitGroup`）。子任务在父任务
  归还计数（`Done`）之前完成入账（`Add`），计数器不会在派生间隙瞬时
  归零——绝不使用“队列瞬时为空调”判完成。
- **失败语义**：任一任务失败即记录首个错误并取消上下文，此后停止继续
  派生；已被接受的任务仍会跑完并计入统计。
- **计数守恒**：`Wait` 返回时恒有 `Submitted == Completed + Failed`。

## API

- `New()` 创建流水线；`Register(stage, Handler)` 注册阶段处理器。
- `Submit(Task)` 入口提交（关闭后返回 `ErrClosed`）。
- `Close()` 关闭入口；`Wait() Stats` 阻塞至全部结束并返回计数。
- `Err()` 返回首个失败错误。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，2026-10-06。

```
$ go test ./...
ok  	pipeline	0.808s

$ go test ./... -race -count=5
ok  	pipeline	5.260s
```

覆盖用例：

- `TestCloseWaitsForAllDescendants`：关闭入口后等待整棵派生树（31 个任务）结束。
- `TestDeriveJustBeforeLastTaskCompletes`：500 级链式派生，每个任务在完成前
  一刻才派生后继，验证不因瞬时空队列提前判定完成。
- `TestFailureStopsDerivation`：失败后慢任务返回的下游任务被拒绝执行，计数守恒。
- `TestSubmitAfterCloseRejected`：关闭后提交返回 `ErrClosed`。
- `TestStatsConservationWithMixedFailures`：混合失败场景下计数守恒且全部已接受任务执行完毕。
