# 采样数据无偏合并

Go priority reservoir 状态库。每条记录以唯一 `ID` 和正权重生成确定性优先级：

```go
priority = U^(1/weight)
```

其中 `U` 是 `ID` 的 SHA-256 稳定 hash 映射到 `(0, 1)` 的值。优先级只取决于记录本身，与插入顺序、进程、分片和重放次数无关。

## 快速使用

```go
r := dataeng.NewReservoir(100)
if err := r.Add("record-id", 2.5); err != nil {
    // 权重非正或为 NaN 时返回 dataeng.ErrInvalidWeight
}
top := r.TopK()
```

分片独立采样后直接合并：

```go
merged, err := dataeng.Merge(shardA, shardB, shardC)
```

当各分片容量均为 `K` 时，`merged.TopK()` 与把所有记录集中送入一个容量为 `K` 的 reservoir 得到的 Top-K 完全一致。也可使用 `dataeng.SampleShards(k, shards)` 一步完成。

## 语义

- 相同 `ID` 与相同权重重复写入是幂等操作，不增加入选概率。
- 相同 `ID` 携带不同权重会返回 `ErrConflictingWeight`，原记录保持不变。
- 权重必须为正且不能是 `NaN`；`+Inf` 表示无限权重。
- 优先级相同时按唯一 `ID` 字典序升序保留。
- `Reservoir` 可直接 `json.Marshal`/`json.Unmarshal`，也实现了 `MarshalBinary`/`UnmarshalBinary` 状态快照。
