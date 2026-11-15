# SQL Server CDC LSN 边界

变更连接器需要可直接接入 Go SQL Server CDC 状态库，按 start_lsn、seqval、operation 和 update mask 组合更新前后行。查询区间端点使用映射函数精确推进，cleanup 导致最小 LSN 越过水位时报告缺口并触发新快照，不能静默跳到当前。

本包实现上述边界语义，且不依赖具体 SQL 驱动：

- `LSN` 提供 binary(10) LSN 的解析、显示、排序、JSON/Text/SQL 编解码，以及 `IncrementLSN` / `DecrementLSN`（对应 `sys.fn_cdc_increment_lsn` / `sys.fn_cdc_decrement_lsn`）。
- `ChangeRow`、`Position` 与 `CombineChangesWithColumns` 按 `(start_lsn, seqval, operation, update_mask)` 去重，并把 operation 3/4 的前后镜像合并成一个 update；update mask 用于得到变更列并合并行。
- `State` 保存完整消费的 `Watermark` 与最后一条 `Position`。只有整个 LSN 已消费时才推进到下一条 LSN；批次停在 LSN 中间时会重读该 LSN，避免跳过同一 LSN 下更大的 seqval。
- `PlanNext` 使用闭区间查询端点。正常推进使用 `sys.fn_cdc_increment_lsn` 语义；若 cleanup 后的 `min_lsn` 已越过水位，则返回 `*GapError`（同时匹配 `ErrLSNGap` 与 `ErrSnapshotRequired`）并给出 `ActionSnapshot`，不会把起点静默改成 `max_lsn`。
- `SQLReader` 直接读取 `sys.fn_cdc_get_min_lsn`、`sys.fn_cdc_get_max_lsn` 和 `cdc.fn_cdc_get_all_changes_<capture>`；更新查询固定使用 `all update old` 以取得前后镜像。
- `Connector.Poll` 组合读取、状态保存和快照回调；状态持久化只在处理器成功且整个查询区间消费完成后发生。

典型流程：

```go
reader, _ := dataeng.NewSQLReader(db, "dbo_customers")
batch, err := reader.ReadBatch(ctx, state, []string{"id", "name", "age"})
if errors.Is(err, dataeng.ErrSnapshotRequired) {
    // 进行新快照；不要把状态直接设为 batch.Bounds.MaxLSN 后继续 CDC。
    // 快照完成后用 state.ResetToSnapshot(snapshotLSN) 记录起点。
} else if err != nil {
    return err
} else {
    for _, change := range batch.Changes {
        // change.Before / change.After / change.ChangedColumns
        state.ObservePosition(change.Position())
    }
    state.CompleteThrough(batch.Plan.Range.ToLSN)
}
```
