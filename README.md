# ledger — 账务分析库

仅使用 Go 标准库。维护按时间及 ID 排序的带符号费用，支持累计查询、
首次越界定位、冲正撤销、双索引原子发布与故障恢复核对。

## 设计

- **条目与批次**（`entry.go`）：`Entry` 带符号金额 + 业务时间 + 提交时间；
  `Batch` 为已锁结算批，锁定后不可改，未锁批次拒绝提交。
- **双索引快照**（`ledger.go`）：同一世代内构建 `(BusinessTime, ID)` 与
  `(SubmitTime, ID)` 两个有序索引及各自前缀和（`pre[0]=0`，空前缀为 0），
  通过 `atomic.Pointer` 整体原子发布；读者无锁，写者互斥。
- **查询**：`Cumulative(axis, n)` 累计和；`FirstExceed(axis, budget)` 首次
  严格超过预算的 1 起始位置（无则 -1）；`PrefixEvidence(axis)` 输出前缀证据；
  业务时间累计与提交时间累计严格分轴。
- **撤销**：`Undo(id)` 不修改原始前缀，而是新增只含冲正条目的已锁结算批；
  冲正继承原条目两轴时间，累计回落可使越界点消失。
- **故障恢复**（`recover.go`）：`Recover()` 以只追加日志为唯一事实来源，
  两轴全账重算、重建索引并原子发布；`VerifySnapshot` 用独立逐项扫描
  核对越界证据，返回全部不一致。

## 测试结果（实际运行记录）

```
$ go test ./... -race -count=1 -v
=== RUN   TestEmptyPrefixIsZero                    --- PASS
=== RUN   TestCumulativeAndFirstExceed             --- PASS
=== RUN   TestNegativeExpensesMatchItemScan        --- PASS
=== RUN   TestUndoRemovesExceedAndKeepsOriginalPrefix --- PASS
=== RUN   TestDualAxisDivergence                   --- PASS
=== RUN   TestBatchLockingAndUndoRules             --- PASS
=== RUN   TestAtomicPublication                    --- PASS
=== RUN   TestRecoveryRecomputesBothAxes           --- PASS
PASS
ok  	ledger	1.389s
```

（沙箱内默认构建缓存只读，运行时使用了 `GOCACHE=/tmp/gocache`。）
