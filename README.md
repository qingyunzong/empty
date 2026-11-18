# 可嵌入的 Go 健康聚合库

这个包把每个实例的 **启动（startup）**、**就绪（readiness）** 和
**存活（liveness）** 探针结果聚合成一个可供负载均衡器直接使用的状态。
它不依赖时钟、网络或第三方库，可以安全地嵌入现有 Go 服务，并支持并发调用。

## 状态

| 状态 | 含义 | 分配流量 |
| --- | --- | --- |
| `StateStarting` | 启动探针尚未成功 | 否 |
| `StateReady` | 启动完成、存活正常、就绪通过 | 是 |
| `StateNotReady` | 启动完成且存活正常，但就绪未通过 | 否 |
| `StateUnhealthy` | 启动失败，或启动完成后存活失败 | 否 |

只有 `StateReady` 会分配流量。就绪通过需要连续成功达到
`ReadinessSuccessThreshold`；连续失败达到 `ReadinessFailureThreshold`
才会摘除。两个方向都有阈值，因此在 `pass/fail/pass/fail/...` 抖动期间
不会每个探针都切换状态。

## 退避与计数

- 每个实例独立维护三组计数器：`Attempts/Successes/Failures` 以及连续成功、
  连续失败计数。`Attempts == Successes + Failures`，实例之间不会串计数。
- 连续失败同时驱动指数退避：`BackoffBase * 2^(n-1)`，由 `BackoffMax` 封顶。
  当前退避级别和下一次探针延迟通过 `Snapshot.BackoffLevel` /
  `Snapshot.NextProbeDelay` 暴露，调度由调用方决定。
- 状态只由该实例自己的探针计数推导；`Record` 返回的 `Snapshot` 就是加入
  本次结果后的完整状态。

## 使用

```go
a, err := formal.New(formal.DefaultConfig(), "api-1", "api-2")
if err != nil {
    return err
}

// 探针执行器每完成一次探测就上报一次结果。
snap, err := a.Record("api-1", formal.ProbeReadiness, formal.BoolResult(ok))
if err != nil {
    return err
}
scheduleNextProbe(snap.NextProbeDelay)

// 负载均衡器只从就绪集合取流量目标。
for _, id := range a.Select(2) {
    route(id)
}
```

`Select` 每次调用都会重新检查实例状态，按稳定的轮询顺序返回就绪实例；
即使摘除和恢复事件交错，也不会返回未就绪实例。`TrafficMap` 可用于核对
每个实例当前的流量资格。

## 验证

测试中包含一个与生产实现完全独立的朴素状态机作为 oracle，并穷举探针序列：

- 单实例：6 种探针事件（3 类 × 2 结果）的全部 6 步序列，共 `6^6 = 46656`
  条，每一步都核对状态、三组计数、退避和流量资格。
- 双实例：两个实例、三类探针的全部 5 步联合序列，共 `12^5 = 248832` 条，
  检查计数不会跨实例泄漏，且 `Select` 不会返回未就绪实例。
- 摘除/恢复交错：两个实例各 `2^7` 种就绪结果序列的全部 `16384` 种组合，
  在 A/B 交错上报时逐步核对状态与流量集合。

运行：

```sh
go test ./...
```
