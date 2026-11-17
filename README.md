# 双层熔断组件

这是一个无后台协程、无外部依赖的 Go 熔断组件，适合直接嵌入 API 网关。

- 路由和上游实例各自维护滑动窗口与状态机。
- 失败率、慢调用率分别使用独立阈值；达到任一阈值即打开。
- 每个路由的所有半开探测（含该路由及其所有实例）共享一个并发限额。
- 被实例熔断器拒绝的请求直接返回 `ErrInstanceOpen`，不会写入路由窗口。
- 打开状态的恢复只依赖注入的 `Clock`，可以用虚拟时钟做确定性测试。

## 基本用法

```go
clock := formal.NewVirtualClock(time.Now())

config := formal.DefaultConfig()
config.SharedHalfOpenProbes = 4

gateway, err := formal.New(config, formal.WithClock(clock))
if err != nil {
    return err
}

permit, err := gateway.Acquire("GET /orders", "10.0.0.8:8080")
if err != nil {
    if errors.Is(err, formal.ErrInstanceOpen) {
        // 换一个实例或直接降级；此拒绝不计入路由统计。
    }
    return err
}

started := clock.Now()
response, callErr := upstream.Do(request)
permit.DoneWithLatency(callErr != nil, clock.Now().Sub(started))
```

`Permit` 必须调用 `Done`、`DoneWithLatency`、`Success`、`Failure`、`Finish`
或 `Cancel` 之一。重复调用会被忽略；半开探测无论成功、失败还是取消都会归还
共享限额。

## 统计口径

路由窗口记录所有通过双层准入的调用。实例窗口只记录该实例收到的调用。
打开或半开限额耗尽造成的快速拒绝不是上游失败，因此不会进入任何统计窗口。
实例超时后独立进入半开；所有实例仍被摘除时，路由半开探测不会被消耗，先恢复
实例，再由可用实例完成路由探测。

## 验证

```sh
go test -race ./...
```

测试覆盖虚拟时钟下的窗口过期、失败/慢调用阈值、打开到半开的状态转换、
并发探测限额守恒、迟到探测隔离，以及“先实例、后路由”的恢复顺序。
