# formal — 分布式任务协调库

供调度器调用的 Go 任务协调库。协调器是确定性的事件溯源状态机：所有状态
变更都记录为带序号与时间戳的 `Event`，不内置时钟、goroutine 或随机源，
因而同一事件日志的重放结果完全确定。

## 核心能力

- **分位数推测副本**：以历史成功运行时长的最近秩（nearest-rank）分位数
  推导慢任务阈值。运行中尝试的最老时长达到 `SlowQuantile`（默认 p90）、
  仍有尝试配额且存在空闲执行器时，才启动一个推测副本，副本总数受
  `MaxAttempts` 限制。
- **首个有效结果提交**：首个通过 `Validate` 校验的结果提交其 shuffle
  分区，并撤销同一任务的其余运行中尝试（发出 `AttemptCancelled`）。
- **恰好一次分区发布**：执行器丢失后的晚到成功、提交后的重复结果、执行器
  不匹配或校验失败的结果都只会产生 `ResultRejected`，分区绝不二次发布。
- **资源计费台账**：每次尝试经过 `HoldPlaced`（预留）→ `UsageBilled`
  （按运行时长折算）→ `HoldReleased`（终结释放）三段记账。

## 典型用法

```go
cfg := formal.DefaultConfig()
c := formal.NewCoordinator(cfg)

c.RegisterExecutor("exec-1", now)
c.SubmitTask(formal.TaskSpec{ID: "t-1", Partition: "shuffle-7"}, now)

// 调度器周期性推进时钟：计费、超时判定、重试与推测。
c.Tick(now.Add(interval))

// 执行器回报结果；无效或晚到结果会被拒绝而不是提交。
c.AttemptSucceeded(formal.Result{
    TaskID: "t-1", AttemptID: "t-1#1", Executor: "exec-1", Payload: "...",
}, later)

// 任意时刻可重放事件日志并校验不变量。
report := c.Replay()
if !report.OK() {
    log.Fatalf("invariant violations: %v", report.Violations)
}
```

## 事件与重放不变量

`Replay(events, cfg)` 重建全部状态并在 `ReplayReport.Violations` 中返回
违例，校验三类不变量：

1. **分区唯一提交**：同一 `ShufflePartition` 最多一条
   `PartitionCommitted`，且提交者必须是成功尝试；
2. **资源计费守恒**：任意时刻预留 `hold` 不为负，每个尝试
   `placed == released`，全局累计预留等于累计释放，重放结束 `hold` 归零；
3. **慢任务不被过早判定**：推测副本不得早于慢任务分位数启动，硬超时
   不得早于 `TimeoutMultiplier × TimeoutQuantile` 触发；历史样本不足时
   既不推测也不超时。

## 策略配置

`DefaultConfig` 默认最多 3 次尝试、p90 触发推测、最少 4 个历史样本，
并禁用硬超时——慢任务只能被推测副本或执行器丢失终结，不会仅因墙钟时间
被杀死。设置 `TimeoutMultiplier > 0` 可显式启用分位数硬超时。

## 验证

```bash
go test -race ./...
```

测试覆盖分位数计算、推测时序、执行器丢失与重试、晚到/无效结果拒绝、
硬超时边界、尝试预算耗尽，以及针对重复提交、计费泄漏和过早推测的重放违例检测。
