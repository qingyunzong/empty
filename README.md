# rint — 有理闭区间计算库

纯 Go 标准库实现（`math/big.Rat` 精确有理数），无第三方依赖。

## 功能

- **区间运算**：`Interval` 为有理闭区间 `[Lo, Hi]`，支持 `Add`/`Sub`/`Mul`/`Div` 与 `Hull`。
- **含零除数**：`Div` 的除数区间包含 0（含端点为 0）时返回无定义（`Undef`），无定义沿运算传播。
- **分支表达式**：`IfE(cond, then, else)` 表示 `cond > 0 ? then : else`。
  区间求值时条件恒正/恒负只取对应分支；条件跨 0 取两分支包络。
- **依赖问题**：`EvalInterval` 是朴素区间算术，共享变量被当作独立区间，
  结果是值域外包（如 `x - x` 在 `[-1,1]` 上得 `[-2,2]`）。
  精确最值用 `ExactRange`：在至多 6 个变量的有限均匀网格上逐点精确求值
  （同一变量在每个点取同一有理数，无依赖高估），返回网格值域的精确界。
- **枚举证书**：`Enumerate` 返回 `Certificate`，记录精确最值、取最值的网格点
  与无定义点统计；`Certificate.Verify` 在证书点上重新求值以核对。

## 限制

- 变量数 ≤ 6（`MaxVars`），网格总点数 ≤ 2^20（`MaxGridPoints`）。
- 网格界是**网格上**的精确最值；对连续值域是内逼近，加密网格可逼近。

## 示例

```go
e := rint.SubE(rint.VarE(0), rint.VarE(0))          // x - x
dom := []rint.Interval{rint.New(big.NewRat(-1,1), big.NewRat(1,1))}
naive := e.EvalInterval(dom)                         // [-2, 2]（外包）
bounds, cert, _ := rint.ExactRange(e, dom, []int{4}) // [0, 0]（精确）
ok := cert.Verify(e)                                 // true
```

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，命令 `go test ./... -v`（GOCACHE 指向可写目录）。

```
=== RUN   TestIntervalArith
--- PASS: TestIntervalArith (0.00s)
=== RUN   TestDivByZeroContainingIntervalIsUndefined
--- PASS: TestDivByZeroContainingIntervalIsUndefined (0.00s)
=== RUN   TestDependencyNaiveVsExact
--- PASS: TestDependencyNaiveVsExact (0.00s)
=== RUN   TestDependencyQuadratic
--- PASS: TestDependencyQuadratic (0.00s)
=== RUN   TestBranchAbs
--- PASS: TestBranchAbs (0.00s)
=== RUN   TestBranchDeterminate
--- PASS: TestBranchDeterminate (0.00s)
=== RUN   TestDivisionOnGrid
--- PASS: TestDivisionOnGrid (0.00s)
=== RUN   TestCertificateTampering
--- PASS: TestCertificateTampering (0.00s)
=== RUN   TestMaxVars
--- PASS: TestMaxVars (0.00s)
=== RUN   TestGridTooLarge
--- PASS: TestGridTooLarge (0.00s)
=== RUN   TestExprVarOutOfRange
--- PASS: TestExprVarOutOfRange (0.00s)
=== RUN   TestAllUndefined
--- PASS: TestAllUndefined (0.00s)
=== RUN   TestSixVars
--- PASS: TestSixVars (0.01s)
PASS
ok  	rint	0.018s
```

13/13 通过。
