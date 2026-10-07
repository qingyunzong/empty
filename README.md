# decimal

Go 十进制任意精度库。数值以**系数 + 尺度**表示：`value = coef * 10^(-scale)`，
系数为 `big.Int`，尺度为 `int32`（可为负，表示 10 的正幂）。

## 语义

- `Add` / `Sub` / `Mul`：精确运算，不舍入。
- `Quo(b, prec)` / `Round(prec)`：按请求的小数位数做**最近偶数舍入**
  （round-half-to-even），且只在最终运算处舍入一次。
- 除零返回 `ErrDivisionByZero`。
- 负零一律归一化为 `0`（解析、运算、舍入结果均如此）。
- `Parse` 支持科学计数法：`"1.5e3"`、`"2.5E-2"`、`".5"`、`"-0.000"` 等。

## 示例

```go
a := decimal.MustParse("1.005")
fmt.Println(a.Round(2))                 // 1      （0.005 半值入偶）
q, _ := decimal.MustParse("1").Quo(decimal.MustParse("8"), 2)
fmt.Println(q)                          // 0.12   （0.125 半值入偶）
```

## 测试

```sh
go test ./...
```

测试包含基于 `math/big.Rat` 的参考核验：随机连算（精确链式运算后仅在末端
舍入一次）与半值/近半值舍入，均与有理数参考结果比对。
