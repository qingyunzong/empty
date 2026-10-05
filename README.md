# readroute

读路由库：读请求携带调用方依赖的**已确认序号**（`Request.MinSeq`），
路由器只把读发给应用序号不小于它的副本；只有显式设置
`Request.AllowStale` 时才允许退化为旧读（结果标记 `Stale`）。
超时返回 `ErrTimeout`，绝不冒充成功返回零值结果。仅使用 Go 标准库。

## 语义

- `Router.Read(ctx, Request{Key, MinSeq, AllowStale})`：
  - 只从 `AppliedSeq() >= MinSeq` 的副本读取，且返回值自带的版本号
    `Seq` 必须也 `>= MinSeq`，否则视为不可证实，继续等待而非返回成功。
  - 无可用新副本时：默认等待（轮询 + `NotifyUpdate` 唤醒）直到超时；
    `AllowStale: true` 时立即从最新副本降级读取，`Result.Stale` 标记
    该值版本低于请求序号。
  - 超时返回 `ErrTimeout` 与零值 `Result`；`ctx` 取消返回 `ctx.Err()`。
- `Router.Unregister(id)` 撤销副本：立即从路由表移除，不再被选中。
- `Clock` 抽象（`RealClock` / `VirtualClock`）：测试用虚拟时钟手动推进
  时间，模拟副本追赶与超时，无需真实睡眠。

## 文件

- `router.go` — 路由器、请求/结果类型、错误定义
- `clock.go` — 时钟抽象与手动推进的 `VirtualClock`
- `memreplica.go` — 内存副本参考实现（`Apply` 模拟日志追赶）
- `router_test.go` / `clock_test.go` — 行为测试

## 测试

`go test ./...` 实际运行结果（Go 1.27.1，linux/amd64）：

```
=== RUN   TestVirtualClockAfterAndAdvance
--- PASS: TestVirtualClockAfterAndAdvance (0.00s)
=== RUN   TestReadServedOnlyByFreshReplica
--- PASS: TestReadServedOnlyByFreshReplica (0.00s)
=== RUN   TestReadWaitsForReplicaCatchUp
--- PASS: TestReadWaitsForReplicaCatchUp (0.01s)
=== RUN   TestTimeoutNeverFakesSuccess
--- PASS: TestTimeoutNeverFakesSuccess (0.03s)
=== RUN   TestStaleReadRequiresExplicitFlag
--- PASS: TestStaleReadRequiresExplicitFlag (0.03s)
=== RUN   TestRevokedReplicaStopsServing
--- PASS: TestRevokedReplicaStopsServing (0.03s)
=== RUN   TestReadWithNoReplicasTimesOut
--- PASS: TestReadWithNoReplicasTimesOut (0.03s)
=== RUN   TestContextCancelAbortsRead
--- PASS: TestContextCancelAbortsRead (0.00s)
=== RUN   TestRegressedVersionIsNotServedAsFresh
--- PASS: TestRegressedVersionIsNotServedAsFresh (0.03s)
PASS
ok  	readroute	0.156s
```

`go test ./... -race -count=1`：`ok readroute 1.204s`（9/9 通过）。
