# Kinesis 聚合记录解包

流接入服务会调用可导入的 Go Kinesis 聚合记录解包组件，验证 protobuf magic、MD5、partition key 表和显式 hash key 索引。子记录保留父 sequence 与 subSequence，重放检查点精确到子记录；坏聚合包作为一个失败单元，不能部分确认。

## 使用

```go
records, err := dataeng.Deaggregate(kinesisData, parentSequenceNumber)
if err != nil {
    // 整个聚合包失败，不能确认其中任何一个子记录。
    return err
}
for _, record := range records {
    // record.SequenceNumber 是父 sequence；SubSequenceNumber 从 0 开始。
    _ = record
}
```

`Deaggregate` 校验四字节 KPL magic、payload 的 MD5、protobuf 结构，以及
partition key / explicit hash key 的 1 起始表索引。任何一步失败都会返回
`nil` 记录，调用方不得部分确认。

批处理使用 `DeaggregateBatch`：任一父记录损坏时整个批次失败，也不会返回
检查点。成功时可把返回的 `Checkpoint`（父 sequence + 子记录序号）持久化；
重放时用 `DeaggregateFromCheckpoint` 丢弃检查点及之前的子记录。
