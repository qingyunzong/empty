# timetable

离散发车偏移优化库：为共享同一循环周期的多条线路选择发车偏移，使换乘罚分最小。

## 模型

- 至多 8 条线路（`MaxLines`），每条线路的候选偏移域至多 12 个值（`MaxDomainSize`），偏移取值 `[0, Period)`。
- 等待时间按周期取模：`wait = (to - from) mod Period`，落在 `[0, Period)`。
- **同刻可换乘**：等待时间为 0 视为立即可换乘，无最小换乘时间；`wait = 0` 不超过任何非负阈值，恒不罚。
- 换乘对 `(From, To, Threshold, Weight)`：当 `wait > Threshold` 时计罚 `Weight * (wait - Threshold)`，否则不罚。
- 目标：总罚分最小；并列时取偏移向量字典序最小者。

## 求解

`Solve` 按字典序枚举各线路域的笛卡尔积，增量累加罚分并以下界剪枝（罚分非负，部分和即下界）；字典序枚举保证首个最优叶即字典序最小解。测试中以独立的朴素笛卡尔积参考实现（`referenceSolve`）对随机实例逐域交叉核验。

## 用法

```go
p := timetable.Problem{
    Period: 10,
    Lines: []timetable.Line{
        {Domain: []int{1, 2}},
        {Domain: []int{3, 4}},
    },
    Transfers: []timetable.Transfer{{From: 0, To: 1, Threshold: 1, Weight: 5}},
}
sol, err := timetable.Solve(p) // sol.Offsets = [2 3], sol.Penalty = 0
```

## 测试

```sh
go test ./...
```
