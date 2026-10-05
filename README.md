# pipes

线性管阻网络求解库（至多 8 节点，有理系数，仅 Go 标准库）。

## 模型

- 边 `e = (From, To, R)`：线性阻力定律 `p_From - p_To = R * q`，`q` 为 From→To 正向流量，`R > 0` 为有理数。
- 每节点边界条件二选一：压头 `Head`（p_i 固定）或注流 `Injection`（净流出 = 注流，即 outflow − inflow = injection）。
- 未知向量 `x = [p_0..p_{N-1}, q_0..q_{E-1}]`，方程组由逐边阻力行与逐节点压头/守恒行组成。

## 求解

`Solve(net, bcs)` 用 `math/big.Rat` 精确高斯消元（RREF）：

- 满秩：返回唯一解 `Unique = true`。
- 无锚连通分量（无任何压头节点）：解非唯一，返回一个特解加零空间基 `Nullspace`（如分量上的常压向量 `(1,1,0)`），作为非唯一性的可验证证据。
- 无锚分量注流和不为零：返回 `*InconsistentError`，指明不平衡分量及其净注流。

## 独立检查器

`CheckSolution` / `CheckNullVector` 不复用求解器矩阵，直接从网络定义逐方程求值，
以精确分数残差报告违例：守恒方程、阻力方程、压头约束（零空间检查含齐次守恒与锚点零压）。

## 测试结果（实际运行）

```
$ go vet ./... && go test ./... -count=1 -v
--- PASS: TestTwoNodeAnchored
--- PASS: TestRationalCoefficients
--- PASS: TestUnanchoredComponentNullspace
--- PASS: TestInconsistentUnanchored
--- PASS: TestCheckerRejectsBadSolution
--- PASS: TestCheckerRejectsBadNullVector
--- PASS: TestTriangleLoop
--- PASS: TestEightNodes
--- PASS: TestDisconnectedMixedComponents
--- PASS: TestValidation
PASS
ok  	pipes	0.011s
```
