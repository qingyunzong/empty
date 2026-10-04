# liability

负债分析库（仅 Go 标准库）。按 **(时间, 序号)** 顺序完整重放借款、部分还款与
冲正事件，计算负债余额，并回答区间查询：**区间最大负债及达到该最大值的最早时刻**。

## 语义

- 余额从 0 开始，任何时刻不为负；金额均为整数（`int64`）。
- `Borrow(a)`：`a > 0`，恒生效，余额 `+= a`。
- `Repay(a)`：仅当 `0 < a <= 余额` 时生效，余额 `-= a`；**非法超额还款不生效**。
- `Reverse(target)`：仅当 target 指向一个已生效且未被冲正过的 Borrow/Repay 时生效，
  精确抵消其效果：冲正还款相当于加回，冲正借款相当于一笔等额还款
  （`amount <= 余额` 才生效）。冲正无效事件、未知序号、冲正事件本身均为空操作。
- 序号必须唯一，重复序号的事件被忽略；事件可乱序插入，重放时自动排序。

## 查询

`MaxLiability(from, to)` 对半开区间 `[from, to)` 返回 `(最大负债, 最早时刻)`。
区间开盘余额（由区间之前的事件累积而来）也参与比较，其时刻记为 `from`，
因此**未偿负债可跨查询边界**。查询通过从首条事件开始的完整重放完成；
`ledger_test.go` 中包含独立的暴力完整重放实现，对随机事件流与随机区间
进行交叉核对。

```go
l := liability.NewLedger()
l.Add(liability.Event{Seq: 1, Time: 10, Kind: liability.KindBorrow, Amount: 100})
l.Add(liability.Event{Seq: 2, Time: 20, Kind: liability.KindRepay, Amount: 30})
max, at := l.MaxLiability(0, 100) // (100, 10)
```

## 测试

```sh
go test ./...
```
