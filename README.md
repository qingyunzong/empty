# auction

Go 拍卖分配库（仅标准库），支持分段需求与订单数量上限。

## 分配规则

- 每个订单由若干 `(价格, 数量)` 需求段组成，并有订单级数量上限 `Cap`。
- 所有订单的需求段按价格从高到低逐段独立参与分配。
- 同一价位总需求不超过剩余供给时，该价位全部成交；否则按比例分配，
  零头按"余数大者优先、并列时订单 ID 小者优先"逐个补齐。
- 同一订单在同一价位的多个段合并为一个需求，保证订单总成交不超过 `Cap`；
  高价段消耗的上限额度会影响该订单后续低价段。
- 成交价为最后一个有成交的价格段的价格；无任何成交时返回空结果
  （`Cleared=false`，`Fills=nil`）。
- `Cancel(id)` 撤单后，下次 `Allocate()` 基于剩余订单重新计算。

## 使用

```go
a := auction.New(100) // 供给 100
a.AddOrder(auction.Order{ID: 1, Cap: 40, Segments: []auction.Segment{
    {Price: 100, Quantity: 20},
    {Price: 90, Quantity: 30},
}})
a.Cancel(1)
r := a.Allocate() // r.Fills / r.ClearingPrice / r.Cleared
```

## 测试

`go test ./...` 覆盖：价高优先、同价比例+余数/ID 分配、数量上限、
清仓价、无成交返回空、撤单重算、数量守恒（500 组随机用例核对
`总成交 == min(供给, Σ min(Cap, 段需求和))`）与独立逐段分配。

实测结果（go1.27.1 linux/amd64）：

```
$ go test ./...
ok  	auction	0.007s
```
