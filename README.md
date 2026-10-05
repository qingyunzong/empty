# 编组 CLI (marshalling)

把至多 18 节车厢**按给定原序**分成若干连续列车，每列受长度、重量与危险品
相邻规则约束，费用按车型计；目标为**总费用最小，平局时列数最少**。
输出分段证书，并穷举全部切分与车型费用对照以验证最优性。仅使用 Go 标准库。

## 规则定义

- **保序连续**：每列车是原序列的一段连续区间，切分即选择 `2^(n-1)` 种切割方案之一。
- **单列限制**：总长 ≤ `maxLength`，总重 ≤ `maxWeight`。
- **危险品相邻**：`hazard` 为危险品品类（0 = 非危险品）。同一列车内，相邻两节
  若均为危险品且**品类不同**则禁止；同品类或一方非危险品均允许。
- **费用**：每列费用 = `trainBase`（固定）+ 列内每种**不同车型**的 `typeCost[t]`
  各计一次（未配置的车型缺省为 1）。
- **目标**：先最小化总费用，并列时取列数最少者。

## 用法

```sh
go build -o marshalling .
./marshalling -input example.json          # 或省略 -input 从标准输入读
./marshalling -input example.json -dump    # 逐条打印全部切分明细
./marshalling -max-len 14 -max-weight 0    # 命令行覆盖上限（0 表示用输入值）
```

输入 JSON 见 `example.json`：`maxLength` / `maxWeight` / `trainBase` /
`typeCost` / `cars[]`（每节含 `id`、`type`、`length`、`weight`、`hazard`）。

## 输出

- **分段证书**：切分区间、每列的车厢/长度/重量/车型构成/危险品检查/费用，
  以及总费用与列数；证书可由 `ValidateCertificate` 独立重算校验。
- **穷举对照**：全部 `2^(n-1)` 种切分中可行数、最小费用、达到最小费用的切分数
  及其中最少列数，并断言证书达到该最优。

## 实现

- `marshal.go`：模型、可行性、费用、前缀 DP 求解（`Solve`）、穷举对照
  （`Exhaustive`）、证书校验（`ValidateCertificate`）。
- `main.go`：CLI 与证书/对照输出。
- 正确性由随机对拍保证：`TestSolveVsExhaustiveRandom` 对 200 组随机问题
  逐一比较 DP 结果与穷举最优。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。命令 `go test ./...` 实际输出：

```
ok  	marshalling	0.031s
```

`go test ./... -v` 下 12 个测试全部 PASS：TestValidate、
TestFeasibleSegmentLimits、TestHazardAdjacency、TestSegmentCost、
TestSolveMatchesExhaustive、TestSolveVsExhaustiveRandom、
TestTieBreakFewerTrains、TestCostPrefersGroupingSameType、TestNoFeasible、
TestValidateCertificateErrors、TestRunEndToEnd、TestRunInfeasible。

性能：18 节车厢穷举 131072 种切分约 0.07s。
