# 多源采集配额调度

采集宿主需要可导入的Go调度组件。任务带来源、到期时间及唯一递增提交序号；调用方配置每来源并发上限、最小启动间隔和全局并发上限，并注入单调时钟。每次有空位时，从已到期且来源可启动的任务中选到期时间最早者，平局按提交序号；完成释放并发额度但不缩短该来源启动间隔。取消未启动任务后不得执行，取消运行任务只发取消信号，直到执行回调结束才释放额度。调用方可原子更新限额，新限额仅约束更新后启动，不中止已运行任务。使用虚拟时钟及可控回调测试同时到期、不同来源受限、取消竞争与动态降低限额。

## 组件结构

- `scheduler.go`：`Scheduler`、`Task`、`Config`、`SourceConfig`、`Handle` 与调度主循环。
- `heap.go`：按 `(Ready, Seq)` 排序的待启动任务小顶堆。
- `clock.go`：`Clock`/`Timer` 抽象，含生产用 `RealClock` 与测试用可推进 `FakeClock`。

## 调度语义

- 选择规则：在“已到期且来源当前可启动”的任务中，取 `Ready` 最早者；`Ready` 相同则取 `Seq` 最小者。
- 来源可启动：来源在跑任务数低于 `SourceConfig.MaxConcurrent`，且距该来源上次启动已过 `MinStartInterval`。
- 全局上限：在跑任务总数达到 `Config.MaxConcurrent` 时不再启动新任务。
- 完成回调返回后才释放全局与来源额度；完成不会缩短、重置该来源的最小启动间隔。
- 取消未启动任务：立即移出队列，永不执行。
- 取消运行任务：仅取消传入回调的 `context.Context`，额度保持到回调返回。
- `UpdateLimits` 原子替换全部限额，只影响更新之后的启动；不中止任何已运行任务。

## 时钟注入

生产环境传入 `NewRealClock()`（基于进程单调时钟）。测试传入 `NewFakeClock(start)`，通过
`Advance(d)` 确定性地推进时间，虚拟时钟上的定时器只在推进到点时触发。

## 用法示例

```go
clk := dataeng.NewRealClock()
sched, err := dataeng.New(dataeng.Config{
    MaxConcurrent: 8,
    SourceLimits: map[string]dataeng.SourceConfig{
        "sensor-a": {MaxConcurrent: 2, MinStartInterval: time.Second},
    },
}, clk, func(ctx context.Context, t dataeng.Task) {
    // 采集逻辑；ctx.Done() 表示运行中被取消
})
if err != nil { /* ... */ }

h, err := sched.Submit(dataeng.Task{Source: "sensor-a", Seq: 42, Ready: clk.Now()})
// 需要时：_ = h.Cancel()
// 调限额：_ = sched.UpdateLimits(newCfg)
// 关闭：sched.Close()
```

## 测试

`go test ./...`，加 `-race` 进行竞态检测。覆盖场景：

- 同时到期按序号、不同到期按最早到期（`TestDispatchEarliestReadyThenSeq`）。
- 全局与每来源并发上限、最小启动间隔及“完成不缩短间隔”。
- 取消未启动/运行任务、取消与派发竞争。
- 动态降低/提高全局与来源限额，已运行任务不中断。
- 虚拟时钟定时器顺序、Stop/Reset，以及关闭后无 goroutine 泄漏。
