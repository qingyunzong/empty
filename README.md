# pipeline

三阶段（可推广为 N 阶段）并发处理库，仅使用 Go 标准库。

## 语义

- **按输入序输出**：每个阶段有多个 worker，项可乱序完成；末级重排缓冲保证输出严格按输入顺序。
- **在途量上限**：接收器在从输入通道读取前先获取信号量槽位，输出发出后才释放，因此即使输出堵塞，已接受但未输出的项数也永不超过 `maxInFlight`。
- **暂停排空**：`Pause` 与接收器握手（同步确认），只阻止接收新输入；已接受的项继续流经各阶段并排空到输出。`Resume` 恢复接收。
- **失败语义**：某阶段对第 k 项报错后，记录最小失败序号，取消所有后续项的 context（注册表逐项取消），已输出的前缀完整保留，`Run` 返回最早失败项的错误。

## 用法

```go
p, _ := pipeline.New(4, 8, s1, s2, s3) // 每阶段 4 worker，在途上限 8
go p.Run(ctx, in, out)                 // in 关闭且排空后返回 nil
p.Pause()                              // 阻塞至接收器确认暂停
p.Resume()
```

## 验收测试（屏障 + 计数器）

- `TestOrderedOutputWithOutOfOrderStages`：反向睡眠制造乱序完成，计数器验证并发度 ≥ 2，输出仍按输入序。
- `TestPauseBlocksNewInputAndDrains`：屏障扣住 4 个已接受项，暂停后验证排空、发送计数冻结，恢复后继续。
- `TestInFlightBoundWithBlockedOutput`：输出堵塞时后台采样器持续记录 `sent - emitted`，断言峰值 ≤ 上限。
- `TestFailureCancelsSubsequentPreservesPrefix`：屏障保证项 4 在项 3 失败时在途，验证项 4 被取消、输出恰为 3 项前缀、`Run` 返回最早错误。
- `TestContextCancellation`：取消运行 context 后 `Run` 返回 `context.Canceled` 且无 goroutine 泄漏。

## 实际测试结果

```
$ go test ./...
ok  	pipeline	0.447s

$ go test -race -count=5 ./...
ok  	pipeline	3.307s
```
