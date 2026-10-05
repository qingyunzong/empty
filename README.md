# rwchain — 有理转移 + 整数收益的马尔可夫链精确分析库

仅使用 Go 标准库（`math/big`），全程精确有理/整数运算，无浮点误差。

## 模型

- 状态 `i = 0..n-1`，转移概率 `P[i][j]` 为有理数（字符串输入，如 `"1/2"`），每行非负且和为 1。
- 每步收益 `R[i]` 为整数：在状态 `i` 停留一步即获得 `R[i]`。

## 三个问题

1. **有限步期望** `E_n = E[Σ_{k=0}^{n-1} R(X_k)]`：分布行向量精确迭代
   `d ← d·P`，逐步累加 `d·R`（`FiniteStepRewards`）。
2. **达到目标前累计收益** `x(i) = E[Σ_{k=0}^{τ-1} R(X_k)]`，`τ` 为击中目标集的时刻：
   对非目标、不受发散类影响的状态解精确线性方程组
   `(I − Q) x = b`，其中 `Q` 为限于这些状态的子转移矩阵，
   `b_i = R_i + Σ_{s∈零收益闭类} P[i][s]·h(s)`（`h` 为闭类 Poisson 势）。
3. **封闭非目标类分类**（`Classes`）：Tarjan 求强连通分量，无离类边者为闭类；
   解 `π(P_C − I) = 0, Σπ = 1` 得平稳分布，算 `μ = Σ π_i R_i`：
   - `μ ≠ 0` → **发散闭类**：类内累计收益以速率 μ 线性发散（可达它的状态记 ±∞）；
   - `μ = 0` → **零收益闭类**：累计收益有界；进入该类的边界值由 Poisson 方程
     `(I − P_C) h = R_C, π·h = 0` 给出（非周期时为严格极限，周期时为 Cesàro 意义）。

## 独立核对（`Verify` / 报告末节）

- **独立分数消元**：主解用 `big.Rat` 高斯消元（`SolveGauss`），另用 `big.Int`
  Bareiss 无分数消元（`SolveBareiss`）独立重解，要求完全一致，并验证残差
  `max|A·x − b| = 0`（精确）。
- **短步展开核对**：`ExpandReward` 不做任何状态聚合、显式枚举全部路径，
  与矩阵迭代的 `FiniteStepRewards` 在短步长上精确相等。

## 输出

`Chain.Report(start, targets, steps)` 打印：模型、有限步期望、击中目标方程组
及解、封闭类证据（逐状态类内概率和/离类边、平稳分布、μ、分类结论）、独立核对结果。

## 测试结果（实际运行记录）

```
$ go test ./...
ok  	rwchain	0.004s
```

`go test -v ./...`：16 个测试 + 1 个示例全部 PASS
（TestNewChainValidates, TestFiniteStepHandComputed,
TestFiniteStepMatchesPathEnumeration, TestFiniteStepConvergesToHittingSolution,
TestClosedClassClassification, TestClassEvidence, TestZeroMeanClassPotential,
TestExpectedToTargetAbsorbing, TestExpectedToTargetDivergent,
TestExpectedToTargetZeroClassBoundary, TestExpectedToTargetZeroMeanClass,
TestExpectedToTargetBadIndex, TestVerify, TestSolveGaussKnown,
TestBareissMatchesGauss, TestSolversDetectSingular, ExampleChain_Report）。
`gofmt -l .` 无输出，`go vet ./...` 通过。
