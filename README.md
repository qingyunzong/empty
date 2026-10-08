# sched

小型排班库：把 ≤10 人安排到 ≤12 个时段，每时段恰好两人上岗。

## 约束

- 每时段从该时段的**资格组合**（`Allowed[s]`，允许的人员对）中选一对；
- 相邻时段的人员对**至少保留一人**（交集非空）；
- 每人**最多连上 3 段**（`MaxRun`）。

## 目标

1. 偏好费用最小：总费用 = 各时段上岗两人的 `Cost[p][s]` 之和；
2. 费用相同时，人员对序列按字典序最小（对 `(a,b)` 先比 `a` 再比 `b`）。

## 用法

```go
inst := sched.Instance{
    NumPeople: 3,
    NumSlots:  2,
    Allowed:   [][]sched.Pair{sched.AllPairs(3), sched.AllPairs(3)},
    Cost:      [][]int{{0, 100}, {0, 0}, {0, 0}}, // Cost[p][s]，nil 表示全 0
}
s, ok := inst.Solve()      // 最优排班；ok=false 表示无可行解
err := inst.Check(s)       // 约束检查器：验证任意排班是否满足全部硬约束
cost := inst.TotalCost(s)  // 总偏好费用
```

## 实现

`Solve` 按时段做带记忆化的动态规划。关键观察：未在上一时段上岗的人连上计数必为 0，
因此状态只需 `(时段, 上一对, 上一对两人的连上数)`，规模 ≤ 12×45×3×3。

## 测试

```sh
go test ./...
```

包含约束检查器的违例用例、费用/字典序/连上上限的确定性用例，以及
`TestExhaustiveShortSequences`：对 2000 个随机短序列实例，将 `Solve`
与暴力穷举的结果逐一对比（可行性、费用、序列完全一致）。
