# 发件箱槽位的缺口与代次

入库衔接调用可导入的Go包跟踪发件箱槽位，不投递消息。槽位序号必须递增，后面的序号不能填平缺口。只有调用方标记已提交的槽位可以派出。回执必须带同一代次，旧代次忽略。已派出未回执的槽位在调用方时钟超时后可以重派，序号保持不变。用可控时钟核对缺口、旧回执和重派，期望不得由被测包生成。

## 用法

`Tracker` 只跟踪槽位状态，本身不投递任何消息，时间完全由调用方注入的 `Clock` 决定：

```go
clock := &myControllableClock{}
tracker := dataeng.NewTracker(clock, 5*time.Second)

seq := tracker.Reserve()          // 事务内预留，序号从 1 递增，永不复用
_ = tracker.Commit(seq)           // 事务提交后标记，未提交的槽位不会被派出

for _, d := range tracker.Poll() { // 返回当前可派出的槽位，按序号排序
    // 调用方自行投递消息；超时未回执的槽位再次 Poll 时以新代次重派，序号不变
    if err := tracker.Ack(d.Sequence, d.Generation); err != nil {
        // ErrStaleGeneration 表示旧代次回执，已被忽略，槽位状态不变
    }
}
```

规则要点：

- `Reserve` 返回严格递增的序号；放弃预留只会留下永久缺口，后续序号不会回填。
- 只有 `Commit` 过的槽位会被 `Poll` 派出，首次派出代次为 1。
- 超时重派保持原序号、代次加一；是否超时只看注入时钟与配置的 timeout。
- `Ack` 必须携带当前在途代次：旧代次返回 `ErrStaleGeneration` 且不改变槽位；已确认槽位的迟到回执返回 `ErrAlreadyAcknowledged`。
- 测试使用测试内可控时钟（`fakeClock`），所有期望序号、代次和超时刻度均为测试中的字面量，不由被测包生成。
