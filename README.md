# idem — 幂等请求执行库

仅使用 Go 标准库。请求以 `Key{ClientID, Generation, Seq}`（客户端 + 世代 + 序号）标识，
在业务状态 `S` 上恰好执行一次。

## 协议与不变量

- **重复返回原决议**：同一 Key 再次提交时回放缓存的决议（`Duplicate`，含业务返回值与
  业务裁决错误），不重新执行 Op。业务拒绝（如余额不足）同样作为决议被缓存并回放。
- **低于回收水位返回已回收**：`Seq <= watermark(client, generation)` 或世代过旧的请求
  返回 `Reclaimed`，绝不重新执行。
- **水位仅由客户端确认推进**：`Ack(clientID, generation, seq)` 是唯一推进水位的途径；
  执行本身从不动水位。Ack 幂等、单调，且不允许超过该世代已执行的最大序号
  （`ErrAckBeyondExecuted`）；旧世代的 Ack 返回 `ErrStaleGeneration`。Ack 推进时回收
  水位以下的缓存记录。
- **缓存与业务提交原子**：Op 以写时复制方式产出下一状态，缓存记录与业务状态在同一把锁
  内一次性安装，两者之间不存在崩溃点。崩溃注入点（`CrashPoint`）只位于该原子区段之外：
  `CrashBeforeCacheWrite`、`CrashBetweenCacheAndCommit`（Op 产出记录之后、原子提交之前）、
  `CrashAfterCommit`。崩溃于提交前 → 两者皆无；崩溃于提交后 → 两者皆有，重试得到
  `Duplicate` 而非重执行。

## 文件

- `idem.go` — 库：`Store[S, V]`、`Execute`、`Ack`、`SetCrashHook`。
- `idem_test.go` — 测试，业务状态为转账账本（写时复制 Op）。

## 测试结果（实际运行）

环境：go1.27.1 linux/amd64（`GOCACHE=/tmp/gocache`，因默认缓存目录只读）。

`go test ./... -v -count=1`：

```
=== RUN   TestDuplicateReturnsOriginalDecision
--- PASS: TestDuplicateReturnsOriginalDecision (0.00s)
=== RUN   TestBelowWatermarkReturnsReclaimedNotReexecuted
--- PASS: TestBelowWatermarkReturnsReclaimedNotReexecuted (0.00s)
=== RUN   TestWatermarkAdvancesOnlyOnClientAck
--- PASS: TestWatermarkAdvancesOnlyOnClientAck (0.00s)
=== RUN   TestCrashBetweenCacheAndBusinessCommitIsAtomic
=== RUN   TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_between_cache_and_commit_applies_nothing
=== RUN   TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_before_cache_write_applies_nothing
=== RUN   TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_after_commit_applies_both
--- PASS: TestCrashBetweenCacheAndBusinessCommitIsAtomic (0.00s)
    --- PASS: TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_between_cache_and_commit_applies_nothing (0.00s)
    --- PASS: TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_before_cache_write_applies_nothing (0.00s)
    --- PASS: TestCrashBetweenCacheAndBusinessCommitIsAtomic/crash_after_commit_applies_both (0.00s)
=== RUN   TestStaleGenerationIsReclaimed
--- PASS: TestStaleGenerationIsReclaimed (0.00s)
=== RUN   TestConcurrentSameKeyExecutesOnce
--- PASS: TestConcurrentSameKeyExecutesOnce (0.00s)
PASS
ok  	idem	0.015s
```

`go test ./... -race -count=1`：`ok  idem  1.070s`（通过，无数据竞争）。
`gofmt -l .` 与 `go vet ./...` 均无输出（干净）。
