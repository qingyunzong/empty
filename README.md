# timetable — 循环时刻表偏移选择库

在循环周期内为 ≤8 条线路选择离散发车偏移（每条线路可选域 ≤12 个取值），
使指定换乘对的等待超时罚分最小；罚分并列时取字典序最小的偏移向量。

## 模型

- 周期 `Period`，所有时间对 `Period` 取模；偏移取值须在 `[0, Period)`。
- 换乘对 `Transfer{From, To, FromTravel, ToTravel, Threshold, Weight}`：
  乘客乘 `From` 线，发车后 `FromTravel` 分钟到达换乘站；`To` 线发车后
  `ToTravel` 分钟到达同一换乘站。
- 等待时间 `WaitTime = (To到站时刻 - From到站时刻) mod Period`，取值 `[0, Period)`。
- **同刻可换乘**：到达与发车同刻时等待为 0，不计罚。
- 等待时间 `> Threshold` 时计罚 `Weight` 分（`Weight <= 0` 按 1 计）。

## 求解目标

1. 总罚分最小；
2. 罚分并列时，偏移向量字典序最小（各域先排序去重后比较）。

## API

- `Solve(p Problem) (offsets []int, penalty int, err error)` —
  分支限界 DFS，按字典序遍历并以下界剪枝，上界规模（8×12）秒级求解。
- `SolveBruteForce(p Problem)` — 逐域笛卡尔积全枚举参考实现，用于核验。
- `Evaluate(p, offsets)` — 计算给定偏移向量的总罚分。
- `WaitTime(period, arrival, departure)` — 周期内等待时间。

## 测试

```sh
go test ./...
```

包含同刻换乘、阈值计罚、权重、字典序并列、参数校验等单元测试，
以及 300 组随机小规模问题下 `Solve` 与 `SolveBruteForce` 的逐域笛卡尔积对照核验。
