# sched — 单机排程库（仅 Go 标准库）

求解带**前置约束图**、**释放时间**与**类别切换耗时**的单机排程问题，
实例规模至多 **16 个工序**。

## 目标

字典序优化：先最小化**最大迟交量** `Lmax = max(C_j - Due_j)`，
再最小化**总完工时间** `SumC = Σ C_j`。

## 用法

```go
in := &sched.Instance{
    Jobs: []sched.Job{
        {ID: "J1", Proc: 3, Due: 5, Class: 0},
        {ID: "J2", Proc: 2, Due: 4, Class: 1},
        {ID: "J3", Proc: 1, Due: 10, Class: 0, Pred: []string{"J1"}},
    },
    Setups: [][]int{{0, 2}, {1, 0}}, // Setups[上一类][下一类]
}
sc, err := sched.Solve(in) // 前置图有环时返回 *sched.CycleError，含具体环
fmt.Print(sc.Render())     // 完整时轴
in.Verify(sc)              // 独立可行性校验
```

## 行为

- `Solve` 先 `Validate`：工序数 1..16、ID 唯一、加工时间 > 0、
  释放时间 ≥ 0、切换矩阵维度与非负性、前置引用存在。
- **环检测**：DFS 检测前置图，返回 `*CycleError`，`Cycle` 字段给出
  具体环（如 `[A C B A]`，首尾相同，沿“工序 → 其前置”方向）。
- **求解**：n ≤ 8 时穷举全部满足前置的排列并带界剪枝，保证最优
  （`Schedule.Exact == true`）；9 ≤ n ≤ 16 时使用束搜索（宽 512）
  给出可行解。
- **时轴**：`Render` 输出每个工序的起止区间、类别与切换耗时，
  以及 `Lmax` / `SumC`。
- `Verify` 重新校验：每工序恰好一次、释放时间、前置先后、不重叠、
  切换耗时与矩阵一致、目标值一致。

## 测试结果（实际运行）

```
$ go test ./...
ok  	sched	0.020s
```

共 10 个测试全部通过，包括：

- `TestExactMatchesBruteForce`：60 个随机实例（2–7 工序，随机前置/
  释放/类别/切换矩阵），`Solve` 结果与测试内独立的全排列穷举
  oracle 逐一比对一致；
- `TestCycleDetection` / `TestSelfLoopIsCycle`：环与自环均被拒绝
  且报告具体环；
- `TestLmaxBeatsSumC`：验证 Lmax 优先于 SumC 的字典序；
- `TestBeamSearchSixteenJobsFeasible`：16 工序启发式解通过 `Verify`。
