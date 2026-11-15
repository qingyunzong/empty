# Kafka 事务标记跨分区可见性

流式落库层需要可导入的 Go 事务批次读取库，联合各分区数据、control batch、producer epoch 与事务标记，只向调用方交付完整已提交事务。分区乱序、leader 截断和 aborted transaction 不得泄漏；恢复后输出与按日志偏移重放一致。

## 包结构

`dataeng` 是一个纯标准库的 read-committed 事务批次读取库：

- `types.go` — `Record` / `Batch` / `FetchResponse` 数据模型与哨兵错误。
- `source.go` — `PartitionSource`、`CheckpointStore` 接口，内存实现 `MemorySource` /
  `MemoryCheckpoint`，以及 `DataBatch` / `PlainBatch` / `ControlBatch` 构造器。
- `reader.go` — `Reader` 状态机：分区拉取、checkpoint 恢复、确定性输出排序。
- `ingest.go` — epoch fencing、幂等 sequence 校验、事务缓冲、commit/abort 收敛、
  LSO 拦截与 leader 截断恢复。

## 语义保证

- **只交付完整已提交事务**：事务数据按分区缓冲，收到 COMMIT control batch 前不输出；
  ABORT 标记的记录全部静默跳过，绝不泄漏。
- **跨分区一致**：同一 `(producer id, epoch)` 的数据与 control marker 联合到同一事务实例，
  marker 可落在任意参与分区、可乱序、可重复。
- **确定性输出**：每次 `Poll` 按分区 id 升序、分区内按 offset 升序交付，与从头按日志偏移
  重放的序列完全一致。
- **Leader 截断安全**：`OffsetOutOfRangeError` 或 leader epoch 回退触发重定位；被截断的
  进行中事务整体 poison（含其它分区上的幸存记录），不会产生部分交付。
- **Producer 防护**：旧 epoch 的批次返回 `ErrFencedProducer`；sequence 空洞返回
  `ErrOutOfSequence`；重试批次按 sequence 去重并计入
  `ReaderStats.DuplicateRecords`，不会二次交付。
- **可恢复**：`CheckpointStore` 只持久化各分区已交付 offset；重启后重建事务状态，输出与
  单次重放一致，不重复、不缺口。

## 用法

```go
src0 := dataeng.NewMemorySource(0)
src1 := dataeng.NewMemorySource(1)

src0.Append(dataeng.DataBatch(0, 0, 0, producerID, 1, true, []byte("v1")))
src0.Append(dataeng.ControlBatch(0, 1, 0, producerID, 1, dataeng.ControlCommit))

reader, err := dataeng.NewReader(ctx,
    []dataeng.PartitionSource{src0, src1},
    dataeng.WithCheckpointStore(store),
)
if err != nil { /* ... */ }

for {
    records, err := reader.Poll(ctx)
    if err != nil { /* fencing / corruption / IO */ }
    for _, record := range records {
        // 仅包含非事务记录和已提交事务记录，按分区/offset 有序
        sink.Write(record)
    }
    if err := reader.Checkpoint(ctx); err != nil { /* ... */ }
}
```

接入真实日志时实现两个接口即可：

- `PartitionSource`：`Fetch(ctx, offset)` 拉取批次并回传 LSO；offset 失效时返回
  `*OffsetOutOfRangeError`；`ListOffsets` 报告当前保留范围。
- `CheckpointStore`：`Load` / `Save` 持久化 `map[partition]lastDeliveredOffset`。

## 测试

```sh
go test -race ./...
```

覆盖提交/中止、跨分区乱序、LSO 拦截、epoch fencing、sequence 空洞与重试去重、
leader 截断（含跨分区 poison）、checkpoint 恢复等价重放及事务元数据 GC。
