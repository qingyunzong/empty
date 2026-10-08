# billing

分段计费库：分段有理单价（货币/单位·小时）× 整数用量曲线，价格与用量均为半开区间 `[Start, End)`。

## 特性

- **精确有理数**：全程 `math/big.Rat` 运算，明细逐条输出 `单价 × 单位 × 小时` 的精确分数金额。
- **半开区间**：相邻分段边界不重复、不遗漏计费。
- **未定价整次报错**：窗口内任一用量大于零的区间缺少价格时，整次计费失败，`*UnpricedError` 列出全部未定价区间（零用量区间不要求价格覆盖）。
- **最近偶数舍入**：仅在最终合计按“分”做 round-half-to-even（`Invoice.TotalCents`）。
- **追溯改价**：`PriceBook.SetPrice` 可覆盖历史区间，重算即生效；`PriceBook.Changes` 保留改价审计日志。

## 示例

```go
book := billing.NewPriceBook()
book.SetPrice(t0, t0.Add(2*time.Hour), big.NewRat(1, 3)) // 1/3 元/单位·小时

curve := billing.NewUsageCurve()
curve.SetUsage(t0, t0.Add(90*time.Minute), 2) // 2 单位，90 分钟

inv, err := billing.Bill(book, curve, t0, t0.Add(2*time.Hour))
// inv.Items[0].Amount == 1/3 × 2 × 3/2 == 1（精确分数）
// inv.TotalCents() == 100（最近偶数舍入到分）
```

## 测试

```sh
go test ./...
```
