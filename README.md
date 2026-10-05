# aggregator

Go 批处理聚合器库（仅标准库）。条目按**容量**或**虚拟超时**封批，封批后内容不可变。

## 语义

- **封批**：`Add` 达到 `capacity` 立即封批；`timeout > 0` 时，自本批首个条目起经过
  `timeout`（由 `Clock` 驱动，`ManualClock` 提供虚拟时间）即封批。`Batch.Items()`
  返回副本，封批后内容不可改变。
- **发送**：封批后由后台 goroutine 调用 `SendFunc`，各批可乱序完成。
- **Flush**：封存当前批并等待所有较早批次完成；若有失败，返回 `*SendError`，
  其 `Seq` 为首个（最小）失败序号。
- **取消等待不取消批次**：`Flush`/`Barrier`/`Close` 的 ctx 取消只解除等待，
  批次仍在后台继续发送。
- **Close**：封存当前批、拒绝新条目（`ErrClosed`）并排空全部批次；幂等。
- **Barrier**：同 `Flush` 等待，并返回 `Report` 核对分批（`Sizes`）与连续确认范围
  `[AckLo, AckHi]`；确认范围未覆盖全部较早批次时返回错误。

## 测试结果（实际运行）

```
$ go vet ./... && go test -race -count=1 -v ./...
=== RUN   TestSealsByCapacity
--- PASS: TestSealsByCapacity (0.00s)
=== RUN   TestSealsByVirtualTimeout
--- PASS: TestSealsByVirtualTimeout (0.00s)
=== RUN   TestSealedBatchImmutable
--- PASS: TestSealedBatchImmutable (0.00s)
=== RUN   TestFlushWaitsForEarlierBatchesOnly
--- PASS: TestFlushWaitsForEarlierBatchesOnly (0.05s)
=== RUN   TestFlushReturnsFirstSequenceFailure
--- PASS: TestFlushReturnsFirstSequenceFailure (0.00s)
=== RUN   TestCloseDrains
--- PASS: TestCloseDrains (0.05s)
=== RUN   TestCancelWaitDoesNotCancelBatch
--- PASS: TestCancelWaitDoesNotCancelBatch (0.00s)
=== RUN   TestBarrierChecksBatchingAndAckRange
--- PASS: TestBarrierChecksBatchingAndAckRange (0.00s)
=== RUN   TestBarrierReportsAckRangeShortfall
--- PASS: TestBarrierReportsAckRangeShortfall (0.00s)
=== RUN   TestFlushEmptyIsNoop
--- PASS: TestFlushEmptyIsNoop (0.00s)
PASS
ok  	aggregator	1.139s

$ go test -race -count=5 ./...
ok  	aggregator	1.584s
```
