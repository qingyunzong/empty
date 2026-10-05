# trainsim — 列车区段互斥模拟

单线区段列车模拟，仅使用 Go 标准库。

## 规则

- **区段互斥**：每个区段同一时刻至多一列列车占用；预约也互斥。
- **制动距离预约**：列车进入下一区段前，必须完整持有前方制动距离内
  所有区段的预约（原子授予，失败则整体拒绝）。
- **冲突优先级**：同一 tick 内按"等待开始时间早者优先，其次列车 ID
  字典序"的顺序处理预约请求。
- **故障车**：故障列车永久占用当前区段不释放（放弃其前方预约），
  后续列车的预约拒绝证据会指名故障车为占用者。

## 输出

`go run .` 运行 10 区段、3 列车（T2 在 tick 4 故障）的场景并输出：

- 每列车的轨迹（tick → 区段）与终态；
- 拒绝证据：每次预约拒绝的 tick、请求列车、所需区段及阻塞者
  （占用者 / 预约持有者）；
- 快照/恢复核对：在 tick 7 取 JSON 快照，从快照重放后续事件，
  每个事件后校验不变量（无重复占段、无重复预约、预约不与他人
  占用重叠、故障车仍持有其区段），并比对恢复终态与原始终态一致。

## 结构

- `sim/sim.go` — 核心模拟：区段表、预约、移动、故障、事件日志、不变量校验
- `sim/snapshot.go` — 快照、事件重放恢复、规范化状态比较
- `sim/sim_test.go` — 单元与集成测试
- `main.go` — 演示场景，输出轨迹与拒绝证据

## 测试结果（实际运行记录）

```
$ go test ./... -v
?   	trainsim	[no test files]
=== RUN   TestMutualExclusionAndBrakingReservation
--- PASS: TestMutualExclusionAndBrakingReservation (0.00s)
=== RUN   TestReservationConflictEvidenceNamesReserver
--- PASS: TestReservationConflictEvidenceNamesReserver (0.00s)
=== RUN   TestWaitPriorityEarliestThenID
--- PASS: TestWaitPriorityEarliestThenID (0.00s)
=== RUN   TestFaultyTrainHoldsSectionForever
--- PASS: TestFaultyTrainHoldsSectionForever (0.00s)
=== RUN   TestArrivalReleasesEverything
--- PASS: TestArrivalReleasesEverything (0.00s)
=== RUN   TestSnapshotRecoverMatchesOriginal
--- PASS: TestSnapshotRecoverMatchesOriginal (0.00s)
=== RUN   TestRecoverDetectsDuplicateOccupancy
--- PASS: TestRecoverDetectsDuplicateOccupancy (0.00s)
=== RUN   TestVerifyDetectsDuplicateReservation
--- PASS: TestVerifyDetectsDuplicateReservation (0.00s)
=== RUN   TestAddTrainValidation
--- PASS: TestAddTrainValidation (0.00s)
=== RUN   TestTrajectoryRecorded
--- PASS: TestTrajectoryRecorded (0.00s)
PASS
ok  	trainsim/sim	0.004s
```

环境：go1.27.1 linux/amd64。`go vet ./...` 无告警。
