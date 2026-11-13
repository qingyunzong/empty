# OAuth 配额分区调度

多租户采集器要调用可导入的 Go 配额调度库，把 provider 的全局、应用、用户和 endpoint 限额同时建模。Retry-After 可为日期或秒，服务器时钟偏差由响应 Date 校正；取消任务归还尚未消费的预约，429 只冻结命中的桶。可注入时钟枚举并发申请以验证不超发且无租户饥饿。

## 用法

```go
cfg := dataeng.Config{
    Global:      dataeng.Rate{Burst: 100, Every: time.Second},
    PerApp:      dataeng.Rate{Burst: 40, Every: time.Second},
    PerUser:     dataeng.Rate{Burst: 10, Every: time.Second},
    PerEndpoint: dataeng.Rate{Burst: 5, Every: time.Second},
}
sched, _ := dataeng.NewScheduler(cfg, nil) // nil 使用真实时钟；测试用 dataeng.NewManualClock

key := dataeng.Key{App: "collector", User: "alice", Endpoint: "/v1/metrics"}

// 预约配额：阻塞直到四个层级都有可用令牌；ctx 取消则放弃排队。
res, err := sched.Acquire(ctx, key, 3)
if err != nil { /* ctx 取消或请求超过桶容量 */ }

res.Consume(1)  // 实际发出请求时消费
res.Cancel()    // 任务取消：未消费的 2 个令牌归还所有层级的桶

// 收到 429：只冻结命中的那个桶（如同 app 的其他 endpoint 不受影响）。
// Retry-After 支持秒或 HTTP 日期；Date 头用于校正服务器时钟偏差。
until, _ := sched.Throttle(key, dataeng.LevelEndpoint,
    resp.Header.Get("Retry-After"), resp.Header.Get("Date"))
```

零值 `Rate` 表示该层级不限流。调度按到达顺序扫描等待队列，先到的请求对其所等待的桶保留份额，因此不会超发，也不会出现租户饥饿。
