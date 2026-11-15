# MongoDB change stream 分片合并

`example.org/dataeng/q0241` 提供一个无驱动依赖、可导入的 Go change stream
合并组件。调用方把各分片驱动返回的事件转换成 `Event`，组件负责全局定序、
迁移去重、世代切换和安全水位。

## 快速使用

```go
merger := dataeng.NewMerger("shard-a", "shard-b")

result, err := merger.PushBatch([]dataeng.Event{
    {
        ShardID:       "shard-a",
        ResumeToken:   "8266...",
        ClusterTime:   dataeng.Timestamp{T: 1720000000, I: 3},
        DocumentKey:   `{"_id":42}`,
        OperationType: "update",
    },
    {
        ShardID:       "shard-b",
        ResumeToken:   "8266...",
        ClusterTime:   dataeng.Timestamp{T: 1720000000, I: 1},
        DocumentKey:   `{"_id":7}`,
        OperationType: "insert",
    },
})
if err != nil {
    return err
}
for _, event := range result.Events {
    consume(event) // 已按全局 Sequence 排好
}

checkpoint := merger.Checkpoint()
// 处理完成后持久化 checkpoint；重启时用 ResumeMerger 恢复。
restored := dataeng.ResumeMerger(checkpoint, dataeng.MergerOptions{})
```

## 语义

- 全局定序：`clusterTime`（先 `T` 后 `I`）→ 分片 → resume token →
  事务身份 → 其他稳定字段。发出事件会分配跨世代连续的 `Sequence`。
- 迁移去重：同一 `DocumentKey`、`ClusterTime` 和操作类型视为同一逻辑事件；
  带事务信息时，`LSID/ID`、事务号与操作序号构成更强的证据，即使 token 或
  clusterTime 不同也会识别为同一事务操作。重复的 resume token 也会被幂等确认。
- 安全水位：`Watermark` 是所有活跃分片已读前沿的最小值，只有全部分片都越过
  的时间前缀才会推进；移除分片后才允许越过该分片。
- 世代：`invalidate` 会先排空当前世代中不晚于它的事件，再发出 invalidate，
  然后递增 `Generation`、清空分片前沿与去重状态；全局水位保持单调，不会回退。
  显式携带旧 `Generation` 的事件会被丢弃；同一 invalidate 的重复分片副本也会
  被识别。
- 检查点：`Checkpoint` 保存世代、全局 `Sequence`、可恢复水位和各分片最后已发出
  事件的 resume token。可恢复水位不会超过“各分片都已发出”的前缀；`Flush`
  排空但领先该前缀的事件仍记录在对应分片 token 中，恢复时不会重复发出。

## 主要 API

- `NewMerger` / `NewMergerWithOptions` / `ResumeMerger`
- `Push` / `PushBatch` / `Accept` / `Drain` / `Flush`
- `Watermark` / `DurableWatermark` / `ShardWatermarks` / `Checkpoint`
- `AddShard` / `AddShardAt` / `RemoveShard` / `SetShards`

`PushBatch` 适合一次读取轮次：同一批中的等时事件会先全部进入缓冲，再统一排序，
避免因单条推送顺序造成回退。
