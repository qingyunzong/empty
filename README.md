# 拓扑分区库

供服务控制器在端点切片更新时调用的 Go 拓扑分区库。它按区域容量比例把每个端点分配到唯一区域，并在区域增减、就绪状态变化时尽量保持既有归属。

## 语义

- `Endpoint.Weight()` 对就绪且未终止的端点返回 1，其余端点返回 0。
- 就绪端点的 `ZoneHint` 是软提示；提示超出容量配额时会被重新平衡。
- 终止端点和未就绪端点仍会获得区域，但不计入提示权重，也不会改变配额；其提示仅在已有配额内作为落位偏好。
- 加权端点数和全部端点数的每区域偏差均小于 1 个端点。
- 稳定输入重复计算不会移动端点；区域或状态变化时尽量只移动为满足配额所必需的端点。
- 分配结果确定，不依赖输入顺序或 map 遍历顺序。

## 用法

```go
allocator := formal.NewAllocator()

result, err := allocator.Allocate(
    []formal.Zone{
        {Name: "zone-a", Capacity: 2},
        {Name: "zone-b", Capacity: 1},
    },
    []formal.Endpoint{
        {ID: "pod-1", ZoneHint: "zone-a", Ready: true},
        {ID: "pod-2", ZoneHint: "zone-b", Ready: true},
        {ID: "pod-3", ZoneHint: "zone-a", Ready: true},
        {ID: "pod-4", ZoneHint: "zone-a", Terminating: true},
    },
)
if err != nil {
    return err
}
// result.Assignments: endpoint ID -> zone
// result.Counts / result.WeightedCounts: all / weighted endpoints per zone
// result.Moved: endpoints that changed zone since the previous call
```

`formal.Partition` 是无状态版本，可显式传入上一次的 `Assignment`。`formal.Verify` 可独立校验一组分配是否覆盖每个端点一次、只使用活动区域，并满足比例偏差上限。

## 测试

```sh
go test ./...
```

测试穷举小拓扑上的区域容量、端点提示和就绪/终止状态组合，逐例按容量比例重新计算每区域应有份额，核对分区、加权数和端点总数；另有拓扑与就绪状态交错变化的序列测试，确认每一步都不丢失、不重复计数，并检查稳定状态零移动。
