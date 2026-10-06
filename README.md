# occupancy

占线规划库：为车次在编号轨道上预留若干半开区间 `[Start, End)`，冲突只在同一轨道
且区间真正重叠时发生（端点相接不算冲突）。时间域为 `[0, 1000)`。

## 功能

- `Planner.AddTrain` / `Reschedule` / `Shift`：整体改签。先把本车旧预约排除再检查
  新方案；新方案无效或冲突时旧方案原样保留。
- `Planner.EarliestShift(id, minDelta, maxDelta)`：找最早可行的整体平移量。用禁止
  区间扫描实现（预约 `[s,e)` 与他车 `[s2,e2)` 冲突当且仅当整数平移量落在
  `[s2-e+1, e2-s-1]`），`EarliestShiftBrute` 为逐时刻参考实现，测试中对拍核验。
- `Planner.AtomicSwap(batch)`：多车次原子交换预约。先移除本批全部旧预约，再整体
  检查全部新预约（含批内互相冲突）；任一失败则整批不变。
- `Planner.CommitBatch(batch, log)` + `Planner.Recover(log)`：带持久意图
  （write-ahead log）的原子批提交。`BEGIN`（含完整新旧布局）→ `INTENT` → 逐车
  `APPLIED` → `COMMIT`。中途崩溃后 `Recover` 只会把布局恢复成整批旧（未提交回滚）
  或整批新（已提交前滚），绝不留下单车改签的中间态。

## 测试

```sh
go test ./...
```

覆盖：半开区间冲突语义、改签排除自身旧预约、失败保留旧方案、手算平移用例、
500 组随机用例扫描法与逐时刻搜索对拍、原子交换全有或全无、以及在提交流程每个
步骤注入崩溃后的恢复一致性。
