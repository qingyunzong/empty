# markov

Go（仅标准库）的有限马尔可夫链精确分析库：有理转移概率（`math/big.Rat`）
+ 整数每步收益。

## 功能

- **有限步期望**：`FiniteHorizon(n)` 按 Bellman 递推
  `v_{k+1}(i) = R[i] + Σ_j P[i][j]·v_k(j)`（`v_0 = 0`）精确计算每状态 n 步累计期望收益。
- **到达目标前累计收益**：`HittingReward()` 对几乎必然到达目标集的状态求解
  首步方程组 `h_i = R[i] + Σ_j P[i][j]·h_j`（目标态 `h = 0`），即 `(I − Q)h = r`，
  用 `big.Rat` 高斯消元精确求解；`Equations` 字段输出该方程组文本。
- **封闭非目标类**：`ClosedNonTargetClasses()` 用 Tarjan SCC 找出不含目标的闭类，
  区分**发散**（类内存在非零收益，累计收益不收敛）与**零收益**（类内收益全 0，
  进入后累计收益保持常数），并在 `Evidence` 中给出闭性证据（每状态的全部正概率
  后继均在类内）。可能落入闭非目标类的状态 `Value` 为 `nil`，`AlmostSure` 为 false。
- **截断展开**：`FiniteHorizonUntilTarget(n)` 给出 `min(n, 击中时间)` 截断的期望，
  在几乎必然到达的状态上收敛到 `HittingReward` 的解。

## 独立核对（测试）

- **独立分数消元**：`SolveBareiss` 用 `big.Int` 无分数 Bareiss 消元（消元过程不用
  `big.Rat`），与 `SolveRational` 的高斯消元在伪随机对角占优系统上逐位一致；
  `TestHittingBareissCrossCheck` 对命中方程组 `(I − Q)h = r` 清分母后用 Bareiss
  重解并与库输出比较。
- **短步展开核对**：`TestFiniteHorizonMatchesPathEnumeration` 用显式路径概率树
  展开（不用 DP）核对 ≤5 步的有限步期望；`TestTruncatedExpansionConverges` 验证
  截断值单调收敛到方程解；`TestHittingResidual` 验证解精确满足 Bellman 方程（残差为 0）。

## 实测结果

```
$ go test ./...
ok  	markov	0.017s
```

（go1.27.1 linux/amd64，14 个测试全部通过；`go vet ./...` 无告警。）
