# DynamoDB Streams 分片继承

采集器要可直接接入 Go DynamoDB Streams 分片调度库，根据 parent/adjacentParent 依赖只在父分片完成后开放子分片。闭合分片水位与输出确认原子推进；reshard 图含缺失父节点时保守等待并报告。多工作者抢占使用租约世代，旧持有者不能提交。

## 使用

`Coordinator` 同时实现 `ShardScheduler`，调度器只需把 DescribeStream 结果映射成 `Shard`：

```go
coordinator := dataeng.NewCoordinator(dataeng.NewMemoryStore())

err := coordinator.Observe(
    dataeng.Shard{ShardID: "parent", EndingSequenceNumber: "100"},
    dataeng.Shard{
        ShardID:               "child",
        ParentShardID:         "parent",
        EndingSequenceNumber:  "200",
    },
)

ready, err := coordinator.ReadyShards(ctx)       // child 在 parent 完成前不会出现
lease, err := coordinator.Acquire(ctx, "parent", "worker-1")
_, err = coordinator.Commit(ctx, lease, dataeng.Progress{
    Watermark: "100",
    OutputAck: "100",
})
```

- parent 与 adjacentParent 都必须处于 `Completed`，子分片才可租用；只闭合但尚未确认输出还不够。
- `Commit` 通过一次 `Store.CompareAndSwap` 同时推进水位、输出确认和完成标记。水位或输出确认未到闭合分片末尾时，不会提前完成。
- 子分片引用了图中不存在的父节点时，`Acquire` 返回 `*MissingParentsError`，`Report.MissingParents` 会列出缺失关系；补齐父节点并完成后自动解除等待。
- 租约每次重新获取都会递增 `Generation`。抢占后旧租约的 `Commit`、`Renew`、`Release` 都返回 `ErrLeaseLost`。

多进程部署实现 `dataeng.Store` 的原子 CAS 即可；单采集器或测试可直接使用 `MemoryStore`。`WithClock` 和 `WithLeaseTTL` 可用于确定性测试。
