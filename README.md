# Top-K 撤回流稳定并列

实时排名服务需要可导入的 Go 可撤回 Top-K 组件，输入带正负权重，按 score、event time、稳定键决胜。删除当前成员时从候选集中补位并输出最小变更；负 multiplicity 拒绝且状态不变。分片状态合并后与全量多重集计算完全一致。

## 用法

组件位于 `topk` 子包（`example.org/dataeng/q0252/topk`）：

```go
r := topk.NewRanker(100) // 跟踪 Top-100

// 正权重加入 / 负权重撤回；每次 Apply 返回最小变更集
changes, err := r.Apply(topk.Record{Key: "user-1", Score: 9.5, EventTime: ts, Weight: 1})
changes, err = r.Apply(topk.Record{Key: "user-1", Weight: -1}) // 撤回，候选集自动补位
// err 为 topk.ErrNegativeMultiplicity 时状态保持不变

top := r.Top() // 当前 Top-K，按 score desc、event time asc、key asc 排序
```

分片合并：

```go
// 各分片独立消费事件流（按 key 路由）
merged := topk.NewState()
for _, shard := range shards {
    merged.Merge(shard.State())
}
global := topk.NewRankerFromState(100, merged) // 与全量流计算结果完全一致
```

运行测试：`go test ./...`
