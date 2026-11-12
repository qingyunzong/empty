# 记录来源的多项式血缘

数据查询宿主可以导入本包，把基础行表示为变量，并用共享子式 DAG 描述
union/join 查询。`union` 是多项式加法，`join` 是乘法；同一来源重复出现
时系数累加，而 `x*x` 保留为 `x^2`。

## 用法

```go
import (
	"errors"
	"fmt"

	dataeng "example.org/dataeng/q0111"
)

x := dataeng.Var("x")
y := dataeng.Var("y")

shared := dataeng.Union(x, y)          // x + y，可在 DAG 中重复使用
square := dataeng.Join(shared, shared) // (x + y)^2
query := dataeng.Union(square, x)

poly, err := dataeng.Compile(query, 100)
if errors.Is(err, dataeng.ErrBudgetExceeded) {
	// 输出超过 100 个单项式；poly 为 nil，不会返回被截断的结果。
}
if err == nil {
	fmt.Println(poly) // y^2 + x + 2*x*y + x^2
}
```

`Var` 对空 ID 或非法 UTF-8 会 panic。输入可能不可信时使用
`NewVar`，它返回 `ErrEmptyVariableID` 或 `ErrInvalidUTF8`。

## 规范形式

- `Polynomial.Variables` 是 DAG 中出现的变量 ID，按 UTF-8 字节序升序。
- 每个 `Term.Exponents` 与 `Variables` 对齐；指数为非负次数。
- 单项式内变量自然按 `Variables` 的 ID 顺序排列。
- `Terms` 按指数列表做字典序升序排列，指数向量唯一。
- 系数是 `big.Int`，始终非负；零系数项不会出现在结果中。
- 零多项式没有变量也没有项。

例如，变量为 `[x y]` 时 `(x+y)^2` 的项顺序是
`y^2`、`2*x*y`、`x^2`，指数分别为 `[0 2]`、`[1 1]`、`[2 0]`。

## 预算

`Compile`/`Eval`/`Expand` 接受可选的单项式上限：

```go
poly, err := dataeng.Compile(expr)     // 不限制
poly, err := dataeng.Compile(expr, 64) // 最多 64 个单项式
```

预算必须是非负数或 `dataeng.Unlimited`。超过上限时返回
`*dataeng.BudgetError`（可用 `errors.Is(err, dataeng.ErrBudgetExceeded)`），
同时 `poly == nil`。预算按最终去重后的非零单项式计数，不会把结果截断成
“成功”的部分多项式。

输入是共享子式 DAG：相同的 `*Expr` 在求值中只展开一次。变量 ID 必须是
非空合法 UTF-8 字符串。

## 测试

测试覆盖变量校验、重复来源系数累加、`x*x` 保留次数、共享子式、分配律、
小整数赋值求值对照、任意精度系数、规范排序和预算未闭合语义：

```sh
go test ./...
go vet ./...
```
