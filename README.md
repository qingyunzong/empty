# ledger

负债分析库（仅 Go 标准库）。按 `(Time, Seq)` 顺序重放借款、部分还款与
冲正事件计算未偿负债；未偿负债可跨查询区间边界结转。查询返回区间
`[start, end]` 内的最大负债及该最大值出现的最早时刻。

## 语义

- `Borrow`：负债增加 `Amount`；`Amount <= 0` 或与生效中事件 ID 重复则不生效。
- `Repay`：负债减少 `Amount`；超额还款（大于当前负债）或非正金额属非法，不生效。
- `Reverse`：冲正 `RefID` 指向的仍生效的借款/还款；目标不存在、已冲正或
  从未生效则不生效；冲正借款若会使负债为负亦不生效。
- 区间起点 `start` 处的负债包含所有 `Time <= start` 的事件（跨边界结转）。
- 同一时刻多个事件按 `Seq` 排序生效。

## 接口

- `NewAnalyzer()` / `AddEvent(e)`：构建分析器并追加事件（可乱序追加）。
- `MaxLiability(start, end) (max, at)`：稀疏表索引，区间查询 O(log n)。
- `ReplayMaxLiability(events, start, end)`：朴素完整重放参考实现，用于核对。

## 测试

`ledger_test.go` 含语义单元测试，以及随机化完整重放核对
（`TestFullReplayCrossCheck`、`TestFullReplayCrossCheckIncremental`）：
随机事件流与随机区间下，索引查询结果必须与完整重放完全一致。

实测结果（go1.27.1 linux/amd64）：

```
$ go test ./...
ok  	ledger	0.186s
```

全部 10 个测试通过（含 2 个随机化重放核对）。
