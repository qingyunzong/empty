# Temporal lookup join 状态组件

`dataeng` 提供可直接接入 Go 数据管道的维表版本状态和 temporal lookup join。

核心约束：

- 每个 key 的版本按 `ValidFrom` 排列，区间为 `[ValidFrom, 下一版本 ValidFrom)`，因此版本天然不重叠。
- 事实使用自己的 `EventTime` 做 as-of 查询，选择 `ValidFrom <= EventTime` 的最后一个版本。
- `SourceSequence` 用于 source 重放幂等；相同 `ValidFrom` 的不同版本不会静默覆盖，而是进入隔离列表。
- 水位线 `AdvanceWatermark` 之前（`EventTime <= watermark`）的事实结果封闭，迟到维表只能修订仍开放的事实。
- `Compact` 只合并相邻且 payload 相同的版本，任意时间点查询到的 payload 保持不变。

## 使用

```go
table := dataeng.NewTable()
table.Apply(dataeng.DimensionChange{
    Key:            "customer-1",
    ValidFrom:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
    SourceSequence: 1001,
    Value:          map[string]any{"tier": "silver"},
})

state := dataeng.NewLookupJoin(table)
result, err := state.ApplyFact(dataeng.Fact{
    ID:        "order-9",
    Key:       "customer-1",
    EventTime: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
    Value:     map[string]any{"amount": 42},
})
// result.Matched, result.Fields["tier"] == "silver"

// 迟到维表：仍开放的事实会得到 RevisionUpdate。
state.Apply(dataeng.DimensionChange{
    Key:            "customer-1",
    ValidFrom:      time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC),
    SourceSequence: 1002,
    Value:          map[string]any{"tier": "gold"},
})
state.AdvanceWatermark(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
```

上游 changelog 直接调用 `Table.Apply`/`LookupJoin.ApplyDimension`；下游增量输出读取
`LookupJoin.Revisions`（或 `TakeRevisions`）。`Conflict` 可通过
`Table.Conflicts`/`TakeConflicts` 进入死信或告警通道。快照可通过 `Table.Snapshot`/
`Table.Load` 持久化和恢复。
