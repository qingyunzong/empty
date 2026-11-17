# 多集群租约状态机

`example.org/dlks/formal/q2563` 提供一个无后台协程、可注入时钟的 Go 租约状态机，供多集群控制器的选主模块周期调用。

## 安全性质

设 `B = ClockSkewBound` 是同一集群内任意两个时钟差值的上界。

- 旧主任期内只在本地时钟到达 `ExpiresAt` 之前自认为 Leader。
- 候选者只有在本地时钟**严格晚于** `ExpiresAt + B` 时才会发起接管。
- 设旧主时钟偏移为 `a`、候选者偏移为 `b`，则 `b-a <= B`。旧主真实停止时刻为 `ExpiresAt-a`，候选者真实接管时刻严格晚于 `ExpiresAt+B-b >= ExpiresAt-a`，因此不存在双主窗口。
- 获选与续约都使用资源版本 CAS。旧主的延迟续约、丢包重发或恢复后的写入不可能覆盖新主的租约。
- 租约以 `(Cluster, LeaseName)` 为键；跨集群同名租约互不竞争，代码还会拒绝采纳键不匹配的返回记录。
- 旧主超过本地期限后先降级，不访问存储；恢复后观察到更高任期或他人的有效租约时保持 Follower。

`ClockSkewBound` 是**两两时钟差**的上界。若每个进程相对参考时钟的误差各为 `E`，应配置 `ClockSkewBound = 2*E`。

## 使用方式

```go
cfg := formal.Config{
    Cluster:        "prod-east",
    LeaseName:      "controller-leader",
    Holder:         podName, // 必须全局唯一
    LeaseDuration:  10 * time.Second,
    RenewInterval:  3 * time.Second,
    ClockSkewBound: 2 * maxPerNodeClockError,
}

machine, err := formal.New(cfg, leaseStore, formal.SystemClock{})
if err != nil {
    return err
}

ticker := time.NewTicker(cfg.RenewInterval / 2)
for {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-ticker.C:
        if err := machine.Tick(ctx); err != nil {
            log.Printf("lease tick: %v", err) // 存储错误不会延长本地租约
        }
    }
}
```

任何需要独占权的操作都必须以 `machine.IsLeader()` 为门槛。`IsLeader` 每次都会重新检查本地期限，因此被暂停后恢复的旧主即使尚未执行下一次 `Tick`，也不会继续通过该检查。

对于外部可见的写操作，还应把 `machine.Term()` 作为 fencing token 传给下游。`IsLeader` 能阻止新的操作开始，但无法中断一个已经被暂停、尚未返回的调用；下游按任期拒绝旧 token 才能覆盖这种情况。

`formal.Store` 只要求三个操作：`Get`、`Create`、`Update`。`Update` 必须按 `expectedResourceVersion` 原子 CAS，`Create` 在键已存在时返回 `ErrResourceVersionConflict`；成功的写必须分配新的非零版本号。租约不应在可能仍有持有者时被删除。

## 故障处理

- **续约丢包**：未收到成功应答前不推进本地期限；若写已生效但应答丢失，下一次 `Tick` 会立即重读并采纳自己的租约，无需等待下一个续约周期。
- **资源版本冲突**：重新读取权威值；发现更高任期或不同持有者立即降级，绝不盲目覆盖。
- **集群隔离/分区**：存储错误只产生错误返回，不推进期限；超过本地期限立即自我降级，网络恢复后再观察新任期的租约。
- **旧主恢复**：`Tick` 先检查本地期限，再访问存储；过期直接降级，之后只能以更高任期重新参选。

## 验证

测试使用可手动推进、可带固定偏移的时钟，并注入请求丢失、应答丢失、版本冲突和分区：

```sh
go test -race ./...
```

覆盖内容包括接管边界、时钟偏差最坏组合、续约全丢、丢失续约应答、候选者与旧主的 CAS 冲突、旧主恢复降级、跨集群隔离，以及 24 个随机种子的并发故障模拟。每个模拟步骤都断言同一集群最多只有一个 `IsLeader()`。

## 时钟假设

每个参与者的时钟在其任期内必须单调，且任意两个时钟的差值不超过 `ClockSkewBound`。所有评估同一租约的参与者必须使用相同的 `ClockSkewBound`、`Cluster` 和 `LeaseName`。运行时手动回拨时钟或偏移越界不在本状态机的保证范围内。
