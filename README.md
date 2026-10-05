# dedup

事件时间有界去重消费库（仅 Go 标准库）。

## 语义

- **有界保留**：水位 = 迄今观测到的最大事件时间（只前进）。键在其事件时间
  `> watermark - retention` 期间保留；水位推进时淘汰落到界外的键。
- **迟到拒绝**：事件时间 `<= watermark - retention` 的事件返回 `Late`，
  直接拒绝，不当新事件、不改状态、不推进水位。
- **冲突检测**：窗口内同键不同载荷（SHA-256 摘要不一致）返回 `Conflict`，
  保留首次记录；同键同载荷返回 `Duplicate`。
- **重启恢复**：`Snapshot`/`Restore` 以 JSON 持久化水位与键窗口，
  重启后去重决策与不重启完全一致。

## API

```go
d, _ := dedup.New(retention)        // retention 必须为正
res := d.Ingest(dedup.Event{Key: k, Payload: p, Time: ts})
// res ∈ ResultNew / ResultDuplicate / ResultConflict / ResultLate
d.Snapshot(w)                        // 持久化水位 + 键窗口
d, _ = dedup.Restore(r)              // 恢复
```

## 测试

模型化测试：随机乱序流（3 个种子 × 20000 事件）逐事件与全历史模型核对，
并校验存活窗口与模型的窗内历史逐键相等；另以同一乱序流对比
"不重启"与"多次快照/恢复重启"的决策序列完全一致。

`go test ./... -race -count=1 -v` 实际结果（go1.27.1 linux/amd64）：

```
=== RUN   TestNewDuplicateConflict
--- PASS: TestNewDuplicateConflict (0.00s)
=== RUN   TestLateRejectedNotTreatedAsNew
--- PASS: TestLateRejectedNotTreatedAsNew (0.00s)
=== RUN   TestWatermarkEvictsKeys
--- PASS: TestWatermarkEvictsKeys (0.00s)
=== RUN   TestNewRejectsNonPositiveRetention
--- PASS: TestNewRejectsNonPositiveRetention (0.00s)
=== RUN   TestSnapshotRestoreRoundTrip
--- PASS: TestSnapshotRestoreRoundTrip (0.00s)
=== RUN   TestRestoreRejectsCorruptSnapshot
--- PASS: TestRestoreRejectsCorruptSnapshot (0.00s)
=== RUN   TestOutOfOrderReplayAgainstFullHistoryModel
=== RUN   TestOutOfOrderReplayAgainstFullHistoryModel/seed=1
    decisions: map[New:13061 Duplicate:493 Conflict:2224 Late:4222]
=== RUN   TestOutOfOrderReplayAgainstFullHistoryModel/seed=2
    decisions: map[New:13114 Duplicate:433 Conflict:2215 Late:4238]
=== RUN   TestOutOfOrderReplayAgainstFullHistoryModel/seed=3
    decisions: map[New:13051 Duplicate:428 Conflict:2255 Late:4266]
--- PASS: TestOutOfOrderReplayAgainstFullHistoryModel (0.86s)
=== RUN   TestRestartPreservesDecisions
--- PASS: TestRestartPreservesDecisions (0.06s)
PASS
ok  	dedup	1.958s
```
