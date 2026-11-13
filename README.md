# 一致性哈希分桶迁移

分布式采集调度器需要可导入的 Go rendezvous hashing 组件，支持节点权重、故障域和版本化成员快照。每个 key 选择主节点及不同故障域备节点；成员变化只影响必要键。浮点权重比较改用确定公式，跨平台结果一致，并输出迁移比例。

## 组件：`rendezvous` 包

导入路径：`example.org/dataeng/q0135/rendezvous`

```go
nodes := []rendezvous.Node{
    {ID: "agent-1", Domain: "rack-a", Weight: 1},
    {ID: "agent-2", Domain: "rack-a", Weight: 2}, // 双倍负载
    {ID: "agent-3", Domain: "rack-b", Weight: 1},
}

// 版本化成员快照：不可变，可并发使用
cur, _ := rendezvous.NewSnapshot(1, nodes)

primary, _ := cur.Lookup("task-0001")        // 主节点
replicas := cur.LookupN("task-0001", 3)      // 主节点 + 不同故障域备节点

// 成员变更后构建新版本快照，统计迁移比例
next, _ := rendezvous.NewSnapshot(2, append(nodes, rendezvous.Node{
    ID: "agent-4", Domain: "rack-c", Weight: 1,
}))
m := cur.MigrationTo(next, keys, 3)
fmt.Printf("主节点迁移比例: %.2f%%, 副本集迁移比例: %.2f%%\n",
    m.PrimaryRatio*100, m.ReplicaRatio*100)
```

### 设计要点

- **确定性评分**：得分采用经典加权 rendezvous 公式 `W / -ln(u)`，但全部以求
  定点整数运算实现（`-ln(u)` 用 atanh 级数的 2^-48 定点近似），不使用任何浮点
  比较，跨平台、跨架构结果逐位一致；权重严格与负载成比例。
- **最小迁移**：rendezvous hashing 的本质保证节点增删只重路由受影响节点上的
  key，其余 key 的主备分配不变（有单元测试验证）。
- **故障域感知**：`LookupN` 优先从不同故障域挑选备节点；故障域数量不足时按得分
  顺序补足副本数。
- **版本化快照**：`Snapshot` 不可变并携带版本号，调度器可并行持有新旧快照进行
  灰度切换与迁移评估。

### 测试

```sh
go test ./rendezvous/
```
