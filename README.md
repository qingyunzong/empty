# 消费组重平衡组件

`formal` 包提供一个由组协调器调用、事件驱动的 Go 重平衡组件。成员加入、显式离开、心跳超时都会推进成员集合并重新分配分区；事件时间由调用方显式传入，因此同样的输入总是产生相同的结果。

## 协议语义

- **两阶段代次切换**：成员变化先产生 pending generation 和 target assignment。所有需要交出分区的成员调用 `AckRevocation` 后，pending generation 才原子激活。激活前 `Assignment` 不会返回待接收的分区，新成员无法与旧成员同时消费同一分区。
- **静态成员**：`JoinOptions.InstanceID` 标识稳定实例。会话超时前使用同一实例重连（即使会话 member ID 变化）不会增加代次，也不会重新分配分区；超过会话期限则释放所有权并重新平衡。
- **代次围栏**：`Commit` 必须携带当前 active generation。新代次激活后，旧代次的提交返回 `ErrStaleGeneration`；已收到撤销请求的成员对该分区的提交返回 `ErrRevoked`。
- **进度单调**：提交偏移按分区持久化，低于上次提交值的提交返回 `ErrOffsetRegression`。新代次的新 owner 从已提交位置继续，因此跨代次进度不会倒退。
- **确定性分配**：分区按 `(topic, id)` 排序，成员按 ID 排序；分配尽量保留现有 owner，再按负载补齐，结果在各成员间保持均衡。

## 主要 API

```go
coordinator, err := NewCoordinator(Partitions("orders", 0, 1, 2, 3))

joined, err := coordinator.Join("consumer-a", JoinOptions{
    InstanceID:     "instance-a", // 可选，静态成员
    SessionTimeout: 10 * time.Second,
}, now)

heartbeat, err := coordinator.Heartbeat("consumer-a", now.Add(time.Second))
expired := coordinator.ExpireHeartbeats(now.Add(11 * time.Second))

ack, err := coordinator.AckRevocation("consumer-a", pendingGeneration)
err = coordinator.Commit("consumer-a", generation, partition, offset)

snapshot := coordinator.Snapshot()
err = coordinator.Validate()
```

`Snapshot.PendingAssignments` 只用于观察或协调，不应作为消费授权；消费授权始终以 `Assignment`/`Consumable` 和当前 active generation 为准。

## 不变量验证

`rebalance_test.go` 使用可控时间线覆盖成员加入、离开、心跳超时、静态重连、撤销确认和 pending 代次被新成员事件取代。每个事件后都会检查：

- 同一代次每个分区最多一个 owner，静止状态下所有分区恰好有一个 owner；
- pending target 也是完整且唯一的；
- 一个分区在同一时刻最多出现在一个成员的 `Consumable` 列表中；
- 代次只增不减，同一 active 代次的归属不会变化；
- 提交偏移按分区严格不降，旧代次提交被拒绝。

运行：

```sh
go test -race ./...
```
