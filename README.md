# API 配额跨租户公平采集

`example.org/dataeng/q0220` 是可嵌入外部 API 采集器的 Go 配额调度库。

## 行为保证

- 每个请求同时检查全局、租户、端点三个令牌桶；三者都有足够令牌时，才在同一把锁内一次性扣减。
- 租户按 `Weight` 使用虚拟完成时间排队。权重为 4 的租户长期获得约 4 倍配额，同时低权重租户仍会被持续调度。
- `Reservation.Commit`、`Fail`、`Cancel` 只有一个能成功；重复调用或并发调用不会重复扣减、退款或延长冷却。
- `Fail(retryAfter)` 会退回令牌，并只阻塞对应端点；全局和租户流量仍可通过其他端点继续。
- 响应头中的 `RateLimit-*`、`X-RateLimit-*`、`Retry-After` 可解析后应用到任意作用域。在途请求未结算时 `Remaining` 只降不升，避免陈旧响应导致超发；结算后以服务端值为准。
- `ManualClock` 让测试完全使用虚拟时间，不依赖 `sleep`。

## 使用

```go
scheduler, err := dataeng.NewScheduler(dataeng.Config{
    Global: dataeng.BucketConfig{Rate: 50, Burst: 10},
    Tenants: map[string]dataeng.TenantConfig{
        "crawler-a": {Weight: 3, Bucket: dataeng.BucketConfig{Rate: 20, Burst: 5}},
        "crawler-b": {Weight: 1, Bucket: dataeng.BucketConfig{Rate: 10, Burst: 3}},
    },
    Endpoints: map[string]dataeng.BucketConfig{
        "/v1/items": {Rate: 15, Burst: 4},
    },
})
if err != nil {
    return err
}
defer scheduler.Close()

reservation, err := scheduler.Acquire(ctx, dataeng.Request{
    Tenant:   "crawler-a",
    Endpoint: "/v1/items",
})
if err != nil {
    return err
}

response, err := send(reservation)
if err != nil {
    reservation.Fail(retryAfterFromError(err))
    return err
}
defer response.Body.Close()

if state, err := dataeng.ParseQuotaHeaders(response.Header, time.Now()); err == nil {
    _ = scheduler.ApplyQuota(dataeng.ScopeEndpoint, "/v1/items", state)
}
reservation.Commit()
```

`BucketConfig` 的零值表示无限制。未配置的租户和端点会在首次使用时以权重 1、无限制桶创建。令牌 `Cost` 默认为 1。

## 虚拟时间

```go
clock := dataeng.NewManualClock(start)
scheduler, _ := dataeng.NewScheduler(dataeng.Config{Clock: clock /* ... */})

clock.Advance(250 * time.Millisecond) // 同步触发到期调度，不产生真实等待
```

测试覆盖：

- 全局、租户、端点各自和组合约束下的任意 1 秒窗口不超额；
- 4:1 权重下长期调度比例，以及低权重租户的最大连续饥饿间隔；
- 预留/提交/失败/取消的并发单次结算；
- `Retry-After` 只影响对应端点；
- 动态额度头收紧剩余额度、窗口重置和恢复配置速率。

运行：

```sh
go test -race ./...
```
