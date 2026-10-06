# colcalc

对 JSON 表（对象数组）执行列计算的 Go 库：算术、比较、逻辑与条件表达式。

## 核心语义

- **三态独立**：每个结果单元格处于 `value` / `missing` / `null` / `error` 之一。
  键不存在 → `missing`；JSON `null` → `null`；求值失败（类型不匹配、除零等）→ `error`。
  三态互不坍缩：`missing` 与 `null` 直接传播，不会与另一操作数的类型错误混淆；
  混合时 `missing` 优先于 `null`。
- **惰性条件**：`if(cond, a, b)` 只计算被选中的分支，未选中分支的错误（如除零）
  不会污染结果。`and` / `or` 同样短路（三值逻辑：`false and ...`、`true or ...` 直接定值）。
- **按行类型推断**：逐行解释执行，每个操作数的类型由当前行的值决定，
  不从首行推导列模式。同一列中数字、字符串、null、缺键混合出现时逐行各自正确处理。
- **数字**：内部统一为 `float64`；`+` 对字符串做拼接；`==` / `!=` 跨类型比较返回
  `false` / `true` 而非报错；`<` 等有序比较跨类型报错；除零 / 取模零报错。

## 用法

```go
rows, _ := colcalc.ParseTable(strings.NewReader(`[
    {"price": 10, "qty": 2},
    {"price": "n/a", "qty": 3}
]`))

total, _ := colcalc.ParseExpr("price * qty")
label, _ := colcalc.ParseExpr(`if(qty > 2, "bulk", "small")`)

out := colcalc.Compute(rows,
    colcalc.Column{Name: "total", Expr: total},
    colcalc.Column{Name: "label", Expr: label},
)
// out[0]["total"] = 20, out[1]["total"] = <error: 类型不匹配>
```

也可以用 Go API 直接构造表达式：`colcalc.Mul(colcalc.Col("price"), colcalc.Col("qty"))`。

表达式语法：`+ - * / %`、比较 `== != < <= > >=`、`and or not`、
`if(c, a, b)`、数字 / 字符串 / `true` / `false` / `null` 字面量、列名标识符、括号。

## 测试

```sh
go test ./...
```

测试以逐行解释为参考，对混合输入（数字 / 字符串 / 布尔 / null / 缺键）
逐行核验每个结果单元格的状态与值。
