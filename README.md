# formal

执行引擎的分区阶段使用的 Go 均衡分区库。它根据观测键频选择范围边界，对热点键做可还原的加盐拆分，并保证所有计划负载守恒。

## 使用

```go
p, err := formal.NewPartitioner(formal.DefaultConfig(8))
if err != nil {
    log.Fatal(err)
}

// ID 非空时重复投递只计一次；数据可以在规划期间继续到达。
p.AddEvent(formal.Event{ID: "evt-1", Key: "tenant-a", Weight: 1})
p.AddEvent(formal.Event{ID: "evt-2", Key: "tenant-a", Weight: 1})

plan, err := p.Plan()
if err != nil {
    log.Fatal(err)
}
if err := plan.Validate(); err != nil {
    log.Fatal(err)
}
```

也可以直接由频率表规划：

```go
plan, err := formal.BuildPlan(map[string]int64{
    "tenant-a": 100,
    "tenant-b": 10,
    "tenant-c": 10,
}, formal.DefaultConfig(4))
```

## 路由与还原

普通键只有一个归属。热点键会有多个加盐子分区：

```go
shares, _ := plan.Placement("tenant-a")
for _, share := range shares {
    // 分区阶段的每条记录使用 occurrence（从 0 开始）选择子分区。
    route, _ := plan.RouteOccurrence("tenant-a", occurrence)
    salted := route.SaltedKey()

    // 下游可还原原始键和盐值。
    original, salt, ok := formal.RestoreSaltedKey(salted)
    _ = original
    _ = salt
    _ = ok
}
```

`Route` 仅返回规范位置（热点键为 salt 0）。需要完整热点键归属时使用
`Placement`/`Ownership`；需要逐条路由时使用 `RouteOccurrence`。

## 不变量

- 分区区间为 `[Start, End)`，按 Partition ID 严格递增，首区间从空串（最小键）开始，末区间无上界。
- 相邻区间首尾相接，无重复、无空洞。
- `Partition.Load == RangeLoad + SplitLoad`，所有分区负载之和等于 `Plan.TotalLoad`。
- 每个加盐桶的 `Salt` 在键内唯一，桶负载之和等于该键观测负载。
- 同一频率表和配置生成完全相同的计划；给定 `Config.Previous` 时，候选方案按 `(最大负载, 迁移负载)` 的字典序和固定候选顺序确定性选择。
- `Plan()` 使用某一时刻的快照。规划期间到达的数据只属于之后的计划；非空事件 ID 保证交错或重试不会重复计数。

## 验证

```sh
go test ./...
go test -race ./...
```

测试包含小键空间穷举（逐 occurrence 路由后对照朴素频率表）、随机频率表核对、
盐键往返、迁移计数以及数据到达与重复规划交错场景。
