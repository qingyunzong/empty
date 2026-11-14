# Pulsar 批消息索引确认

事件接入服务会调用可导入的 Go Pulsar 批消息确认状态库，联合 ledger、entry、batch index 与 cumulative ack。单条失败时只重投未确认索引，批次重投不得重复发布已提交输出；topic 卸载和订阅世代变化使旧 ack 失效。状态可序列化后精确恢复。

## 导入

```go
import dataeng "example.org/dataeng/q0019"
```

## 核心语义

- `MessageID` 由 `LedgerID`、`EntryID`、`BatchIndex` 组成；`BatchIndex == -1` 表示非批消息。
- `AckIndividual` 只确认一个逻辑索引；`AckCumulative` 确认坐标不大于目标的所有 ledger、entry 与 batch index。
- “确认状态”和“输出已提交状态”分开保存。批次重投时：
  - `ToPublish`：尚无已提交输出，可以执行并发布；
  - `ToAck`：输出已经提交，只补发 ack，绝不重复发布；
  - `Acknowledged`：直接跳过。
- `OnTopicUnload`、`AdvanceSubscriptionGeneration` 等会清除旧 ack，但保留已提交输出，避免重投造成重复输出。
- 异步 ack 回包使用 `AckAt(token, ...)`；token 过期时返回 `ErrStaleGeneration`，不会污染新世代状态。
- `MarshalBinary` / `Restore`、`MarshalJSON` / `UnmarshalJSON` 与 `Snapshot` / `Restore` 均可精确恢复状态。

## 重投处理示例

```go
tracker, err := dataeng.Restore(persisted)
if err != nil {
    return err
}

token := tracker.Token()
batch := dataeng.BatchID{LedgerID: 42, EntryID: 7, Count: 10}
status := tracker.ScanBatch(batch)

// 只发布没有已提交输出的未确认索引。
for _, index := range status.ToPublish {
    id := batch.Message(index)
    if err := publishExactlyOnce(id); err != nil {
        continue // 保留为未确认，下轮只重投该索引
    }
    if err := tracker.MarkPublished(id); err != nil {
        return err
    }
    if err := tracker.AckIndividualAt(token, id); err != nil {
        return err
    }
}

// 已提交但 ack 未送达的索引只补 ack。
for _, index := range status.ToAck {
    if err := tracker.AckIndividualAt(token, batch.Message(index)); err != nil {
        return err
    }
}

// topic 卸载或订阅世代变化时：
tracker.OnTopicUnload()
tracker.AdvanceSubscriptionGeneration()

// 持久化：
persisted, err = tracker.MarshalBinary()
```
