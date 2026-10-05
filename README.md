# trafficsim

确定性、按 tick 推进的交通模拟库，仅使用 Go 标准库。

## 模型

- **车辆按路线占路段**：车辆是沿路线（相连有向路段序列）排列的单元格队列，
  `Cells[0]` 为车头。每 tick 整车前移一格：尾格释放、新头格占用。
- **车尾离段前仍占容量**：车头进入下一路段后，尾格仍占用原路段容量，
  直到车尾本身离开（见 `TestTailOccupiesUntilItLeaves`）。
- **路口互斥冲突表公开**：`ConflictTable`（`conflict.go`）为公开 API。
  同一路口两个移动（`Movement{From, To}`）默认互斥，`Allow` 显式标记兼容
  （如对向直行），`Forbid` 撤销。
- **同 tick 先释放再授予**：`Sim.Step` 第一阶段执行段内移动与尾格释放；
  第二阶段在释放后的占用状态上，按 **等待时长降序、车辆 ID 升序** 依次授予
  路口通行，授予需满足入口格空闲且与同路口本 tick 已授予移动不冲突。
- **快照继续运行轨迹一致**：`Snapshot`/`Restore`（gob 编码完整状态）恢复后
  继续运行的逐 tick 轨迹与不间断运行完全一致
  （见 `TestSnapshotRestoreIdenticalTrajectory`）。

## 不变量与证据

`Sim.Verify` 每 tick 校验：车辆守恒（Spawned == 活跃 + 完成）、无碰撞
（任意两车不共格、单元格在界内且沿路线连续、占用索引精确一致）。
`WaitForEdges` + `FindCycle` 构建容量等待图并检测死锁环：
自由流场景 200 tick 无环，构造的满环 gridlock 场景能检出 4 车环，
证明检测非空转。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，`go test ./... -race -count=1 -v`：

```
=== RUN   TestConservationAndNoCollision
    conservation: spawned=8 finished=8 active=0 over 200 ticks, Verify ok every tick
--- PASS: TestConservationAndNoCollision (0.01s)
=== RUN   TestGrantOrderWaitThenID
--- PASS: TestGrantOrderWaitThenID (0.00s)
=== RUN   TestConflictTableIsPublicAndEnforced
--- PASS: TestConflictTableIsPublicAndEnforced (0.00s)
=== RUN   TestTailOccupiesUntilItLeaves
--- PASS: TestTailOccupiesUntilItLeaves (0.00s)
=== RUN   TestSnapshotRestoreIdenticalTrajectory
    snapshot at tick 30: restored run matches uninterrupted 50-tick trajectory exactly
--- PASS: TestSnapshotRestoreIdenticalTrajectory (0.03s)
=== RUN   TestNoDeadlockCycleFreeFlow
    deadlock evidence: 200 ticks, wait-for graph acyclic every tick (32 capacity-wait edges inspected)
--- PASS: TestNoDeadlockCycleFreeFlow (0.01s)
=== RUN   TestDeadlockCycleDetected
    gridlock evidence: detector reports cycle [1 2 3 4] in a fully locked ring
--- PASS: TestDeadlockCycleDetected (0.00s)
=== RUN   TestStateStringIsDeterministic
--- PASS: TestStateStringIsDeterministic (0.04s)
PASS
ok  	trafficsim	1.158s
```
