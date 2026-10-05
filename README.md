# placement

任务安置库（纯 Go 标准库，无第三方依赖）：把至多 18 个任务分配到 4 台
机器，考虑 CPU / 内存双资源容量、亲和（Allowed）与禁同机（Conflicts）
约束，最小化「开机费用 + 迁移费用」，并输出分配序列与容量证书。
找不到可行解时保持旧方案。

## 用法

```go
p := placement.Problem{
    Tasks: []placement.Task{
        {Name: "a", CPU: 2, Mem: 2},                          // 任意机器
        {Name: "b", CPU: 3, Mem: 1, Allowed: []bool{false, true, true, true}}, // 亲和
    },
    Machines: []placement.Machine{
        {Name: "m0", CPUCap: 8, MemCap: 8, Running: true},    // 已开机，免开机费
        {Name: "m1", CPUCap: 8, MemCap: 8, StartupCost: 10},
    },
    Conflicts:     [][2]int{{0, 1}},   // a 与 b 禁同机
    OldPlacement:  []int{0, 0},        // 旧方案，-1 表示未安置
    MigrationCost: 7,                  // 每迁移一个任务的费用
}
r := placement.Solve(p)
fmt.Print(r.String(p)) // 分配序列 + 容量证书
```

- `Solve` 用分支定界求最优解；旧方案可行时作为初始上界加速剪枝。
- `Result.Certificate` 是容量证书：逐机器 CPU/内存用量对容量、开机与
  迁移费用明细，可用 `Problem.Verify` 独立复核。
- 不可行（或输入非法）时 `Result.KeptOld == true`，`Placement` 为旧方案。

## 测试

```
go test ./...
```

实测结果（go1.27.1 linux/amd64，2026-10-05）：

```
=== RUN   TestPacksOntoOneMachine        --- PASS (0.00s)
=== RUN   TestAntiAffinityForcesSecondMachine --- PASS (0.00s)
=== RUN   TestAffinityRestrictsMachine   --- PASS (0.00s)
=== RUN   TestMigrationAvoidedWhenPossible  --- PASS (0.00s)
=== RUN   TestInfeasibleKeepsOldPlacement   --- PASS (0.00s)
=== RUN   TestVerifyRejectsViolations    --- PASS (0.00s)
=== RUN   TestExhaustiveSmall            --- PASS (0.23s)  // 400 个随机小实例与穷举对拍
=== RUN   TestEighteenTasks              --- PASS (0.00s)  // 18 任务 × 4 机器全规模
PASS
ok      placement       0.237s
```

注：本机默认构建缓存目录只读，需 `GOCACHE=/tmp/gocache go test ./...`。
