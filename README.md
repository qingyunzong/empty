# formal — 可嵌入的连接表

`formal` 是一个并发安全的 Go 五元组连接表，适用于四层软件负载均衡器或
NAT/代理的数据面。它只负责“连接属于哪个后端”的状态管理，不绑定任何网络
框架，可直接嵌入现有转发流程。

## 特性

- **活跃连接强粘性**：`Open` 返回后，五元组到后端的绑定在连接的整个代次内
  不可变。`SetBackends`、`Drain`、节点删除都不会改写活跃连接。
- **加权一致性哈希**：未知五元组按虚拟节点一致性哈希环分配。节点增删只移动
  原属该节点（删除）或新节点（新增）的键，权重通过虚拟节点比例体现。
- **NAT 端口复用代次保护**：每次成功建连都会获得单调递增的 `Generation`。
  `Close`/`Touch` 必须携带代次；旧连接的迟到 FIN/RST 会得到
  `ErrStaleGeneration`，不会误删复用同一五元组的新连接。
- **排空只迁移已关闭连接**：`Drain` 立即把该后端的**墓碑**迁走，仍活跃的连接
  保持原后端，待其关闭或超时后才迁移。
- **空闲超时**：`IdleTimeout` + `Sweep`/`Expire` 关闭空闲连接；过期后按普通
  关闭路径处理，包括排空迁移。
- **可观测**：`Stats`、`Len`、`Backends` 提供计数、代次、迁移和环密度快照。

## 快速使用

```go
tbl, err := formal.NewTable(formal.Config{
    Backends: []formal.Backend{
        {ID: "api-1", Addr: "10.0.0.1:8080", Weight: 2},
        {ID: "api-2", Addr: "10.0.0.2:8080", Weight: 1},
    },
    IdleTimeout: 30 * time.Second,
})
if err != nil {
    return err
}

key := formal.FiveTuple{
    SrcAddr:  netip.MustParseAddr("192.0.2.10"),
    SrcPort:  40000,
    DstAddr:  netip.MustParseAddr("198.51.100.20"),
    DstPort:  443,
    Protocol: 6, // TCP
}

conn, err := tbl.Open(key)
if errors.Is(err, formal.ErrFlowActive) {
    // NAT 想复用仍活跃的端口：拒绝或换端口。
}

// 数据面收到报文时刷新空闲时间。
_, err = tbl.Touch(key, conn.Generation)

// 连接结束；旧代次的 Close 不会影响复用后的新连接。
result, err := tbl.Close(key, conn.Generation)
_ = result

// 节点排空：活跃连接留在 api-2，只有已关闭墓碑被迁移。
drain, err := tbl.Drain("api-2")
_, _ = drain.Active, drain.Migrated
```

## 语义

| 场景 | 行为 |
| --- | --- |
| 活跃五元组 | 后端与代次固定，任何后端集合变更都不改写 |
| 未知五元组 | 加权一致性哈希选择后端 |
| 已关闭五元组重新建连 | 原后端仍可用则保留亲和；否则重新哈希 |
| 同一五元组仍活跃时再次 `Open` | 返回 `ErrFlowActive`，绝不共享连接 |
| 旧代次的 `Close`/`Touch` | 返回 `ErrStaleGeneration` |
| `Drain(id)` | 从环中移除；迁走已关闭墓碑，保留活跃连接 |
| 活跃连接关闭/超时时后端在排空 | 该墓碑立即迁移 |
| 后端集合为空 | 活跃连接保留；新连接返回 `ErrNoBackends` |

已关闭条目会作为墓碑保留，以维持五元组亲和并识别迟到释放。若不需要保留，
可调用 `Forget(key, generation)` 主动回收。`Stats.Closed` 可用于触发清理策略。

## 验证

测试覆盖加权分布误差、节点增删最小迁移、代次隔离、排空只迁移墓碑、空闲超时、
并发建连与节点抖动，并断言活跃连接的后端/代次从不被改写：

```sh
go test ./... -count=1
go test ./... -count=1 -race
```
