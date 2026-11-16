# 流去重布隆过滤器换代

事件入口需要可导入的 Go 分层去重组件，近期精确集合与可轮换布隆层共同工作。轮换绑定事件时间窗和水位，不能因处理延迟提前遗忘；布隆命中只作为疑似时查持久索引。检查点恢复保持相同假阳性路径，绝不产生假阴性。

## 组件：`dedup` 包

`import "example.org/dataeng/q0255/dedup"`

分层结构（由热到冷）：

- **精确集合**：当前事件时间窗的全部键，判定精确；
- **可轮换布隆层**：水位每越过一个窗界，精确集合封存为一个布隆层，保留 `WindowCount` 层；
- **持久索引**（`Index` 接口）：布隆命中仅视为疑似，须查索引确认；早于所有保留窗的事件直接查索引。

关键语义：

- 轮换只由 `AdvanceWatermark` 驱动，组件不读墙钟，处理延迟不会导致提前遗忘；
- 假阳性只带来一次额外的索引查询，绝不改变判定结果；每个新键先写索引再入内存，无假阴性；
- `Snapshot`/`Restore` 使用确定性哈希与完整序列化，恢复后假阳性路径逐位一致；索引若实现 `CheckpointableIndex`，快照前会先冲刷，重启时索引与快照须对齐到同一代检查点。

```go
cfg := dedup.Config{
    WindowSize:        time.Hour,
    WindowCount:       24,
    ExpectedPerWindow: 1_000_000,
    FalsePositiveRate: 0.001,
}
d, _ := dedup.New(cfg, myIndex) // myIndex 实现 dedup.Index
dup, err := d.CheckAndAdd(ctx, event.ID, event.EventTime)
d.AdvanceWatermark(wm)          // 由事件时间推进驱动轮换
snap, _ := d.Snapshot(ctx)      // 检查点
d2, _ := dedup.Restore(snap, myIndex)
```

运行测试：`go test ./dedup/`
