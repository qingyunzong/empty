# 多来源分页归并与恢复

采集宿主需要可导入的Go分页合并组件。调用方给定非空多个不可变快照来源及各自非空初始游标；每页非空，同一来源的记录跨页按整数时间再ID严格升序，末页下一游标为空，其他游标在快照内唯一。同ID在所有来源的时间和内容均相同。组件按该顺序归并去重，每批最多交付指定正整数条；检查点保存各来源当前页游标、页内已消费位置和最近交付记录的排序键，所有来源耗尽时保存完成标记。调用方通过事务接口原子确认结果和检查点；确认明确失败不能推进；结果不明或恢复时先读取持久检查点，已推进则不得重发，未推进可重发相同批次，读取失败则停止。来源读取失败不交付本批。测试跨页重复、来源提前结束、读取中断与确认失败，对照全量排序去重参考结果。

## 包结构

- `types.go`：`Record`、`SortKey`、`Source`、`Checkpoint`、`CheckpointStore`、
  `Transaction` 等核心类型与接口，以及 `ErrComplete`、`ErrRejected`、
  `ErrAmbiguous` 哨兵错误。
- `merger.go`：`Merger` 归并器。基于最小堆做 k 路归并，按“时间再 ID”全局
  升序交付并跨来源去重；维护每来源当前页游标、下一游标与页内消费偏移。
- `store.go`：`MemoryStore` 与 `MemoryTransaction` 内存实现，供宿主参考与测试
  使用，支持脚本化的明确拒绝、不明结果与检查点读取失败。

## 关键语义

- 每批最多 `batchSize` 条去重记录，记录非空；全量重复的尾部不会产生空批次，
  而是在所有来源耗尽后确认完成标记并返回 `ErrComplete`。
- 检查点 `Checkpoint` 记录每个来源的 `Cursor`、`NextCursor`、`Consumed`，
  最近交付排序键 `LastDelivered`，以及完成标记 `Complete`。
- `Transaction.Confirm` 原子提交批次与检查点：
  - 包装 `ErrRejected` 表示明确失败，状态不推进，下次 `Next` 重发同一批次；
  - 其他错误表示结果不明，归并器先调用 `CheckpointStore.Load` 读取持久检查点，
    已推进则跳过该批次，未推进则重发；`Load` 失败时停止并返回错误。
- 来源 `Fetch` 失败时本批不交付、检查点不推进，下次 `Next` 从已确认位置重建。
- `ResumeMerger` 可从持久检查点重建归并器，跳过 `LastDelivered` 及之前的记录。

## 用法示例

```go
tx := NewMemoryTransaction() // 生产环境替换为实现 Transaction + CheckpointStore 的宿主事务
merger, err := NewMerger(sources, initialCursors, 100, tx)
if err != nil {
    return err
}
for {
    batch, err := merger.Next(ctx)
    if errors.Is(err, ErrComplete) {
        break
    }
    if err != nil {
        return err // 读取中断、确认失败或检查点读取失败，按语义重试或停止
    }
    _ = batch
}

// 进程恢复：用持久化检查点重建
restored, err := ResumeMerger(sources, loadedCheckpoint, 100, tx)
```

宿主自有事务需同时实现 `Transaction`（原子写结果与检查点）和
`CheckpointStore`（恢复时读取检查点）。明确失败返回
`fmt.Errorf("...: %w", ErrRejected)`，结果不明返回普通错误。

## 测试

- `merger_test.go`：参考结果对照、跨页去重、来源提前结束、读取中断、明确
  拒绝重发、不明结果的已提交/未提交两条恢复路径、检查点读取失败停止、
  断点续跑。
- `merger_edge_test.go`：全重复尾部无空批次、恢复后跳过已交付重复。
- `merger_property_test.go`：随机多来源分页数据对照全量排序去重参考结果。

运行：`go test ./... -count=1`，竞态检测：`go test -race ./...`。
