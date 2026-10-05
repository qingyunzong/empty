# sim — 离散事件仿真库

仅依赖 Go 标准库（`container/heap`、`fmt`）。

## 语义

- **事件派生后继**：`Handler` 在执行期间可通过 `Sim.Schedule` / `Sim.ScheduleAt`
  派生任意后继事件；队列按 `(时间, 入队序号)` 排序，同时刻事件先到先服务。
- **停止条件**：`Run` 仅当「无待发事件 **且** 全部组件无可触发动作」时停止。
  队列瞬时空不是停止条件——每轮队列排空后都会轮询所有已注册组件的
  `Triggerable`，动作可派生新事件继续推进仿真。
- **预算与待办证据**：`Budget{MaxEvents, MaxTime}` 任一超限且仍有待办时，
  `Run` 返回 `*BudgetExceededError`，其 `Evidence` 字段给出待办证据：
  当前时刻、已处理步数、全部待发事件摘要（ID/时刻/类型）与全部可触发动作
  描述（`组件名: 动作描述`）。
- **快照**：`Sim.Snapshot` 保存时钟、计数器、待发事件、各组件状态以及
  **随机数发生器状态**（splitmix64，状态为单个 uint64，见 `rng.go`）；
  `Sim.Restore` 恢复后继续演化，与从头完整演化逐事件一致
  （`TestSnapshotRestoreMatchesFullRun` 对照验证）。

## 文件

- `rng.go` — 可精确快照的 splitmix64 随机源
- `sim.go` — 事件、组件、预算、证据与主循环
- `queue.go` — 事件优先队列
- `snapshot.go` — 快照 / 恢复
- `sim_test.go` — 测试（含小车间模型：源组件发job、随机服务时长、30% 返工派生后继）

## 测试结果（实际运行记录）

环境：`go version go1.27.1 linux/amd64`，命令：`go test ./... -count=1 -v`

```
=== RUN   TestEventSpawnsSuccessors
--- PASS: TestEventSpawnsSuccessors (0.00s)
=== RUN   TestEmptyQueueIsNotAStopCondition
--- PASS: TestEmptyQueueIsNotAStopCondition (0.00s)
=== RUN   TestBudgetExceededGivesPendingEventEvidence
--- PASS: TestBudgetExceededGivesPendingEventEvidence (0.00s)
=== RUN   TestBudgetExceededGivesPendingActionEvidence
--- PASS: TestBudgetExceededGivesPendingActionEvidence (0.00s)
=== RUN   TestTimeBudgetEvidence
--- PASS: TestTimeBudgetEvidence (0.00s)
=== RUN   TestDeterminism
--- PASS: TestDeterminism (0.00s)
=== RUN   TestSnapshotRestoreMatchesFullRun
--- PASS: TestSnapshotRestoreMatchesFullRun (0.00s)
=== RUN   TestRestoreUnknownComponentFails
--- PASS: TestRestoreUnknownComponentFails (0.00s)
PASS
ok  	sim	0.003s
```

8/8 通过。
