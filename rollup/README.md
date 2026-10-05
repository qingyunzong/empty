# rollup

汇总库：从原始事件维护日、周、月三层计数。仅依赖 Go 标准库。

## 设计

- **日历**（`calendar.go`）：日为调用方提供的显式整数，周由固定的
  `WeekOrigin` 以地板除推导（原点前为负周），月为事件携带的显式整数。
  全程不接触系统时钟与时区。
- **三层计数**（`store.go`）：`Store` 保存只追加的原始事件台账
  （ledger）+ day/week/month 三个聚合层。台账是唯一事实来源。
- **幂等重放**：`Apply` 按事件 ID 去重，已激活的 ID 重复重放为无操作，
  不会二次计数。
- **撤销校验**：`Undo` 对不存在或已撤销的 ID 返回错误。
- **故障注入与恢复**：`InjectFault(step)` 在三层更新的第 step 层之后
  （1=日、2=周、3=月）注入一次性故障，模拟崩溃留下部分更新的聚合层。
  台账先于聚合层写入（WAL 式），`Recover` 从台账重放全部激活事件，
  重建结果与无故障重算完全一致。

## 测试结果

`go test ./...` 实际运行结果（go1.27.1 linux/amd64）：

```
ok  	rollup	0.006s
```

共 6 个测试、27 个用例全部 PASS，包括：

- `TestCalendarWeekOrigin`：周原点与负日地板除
- `TestDayWeekMonthCounts`：三层计数正确性
- `TestDuplicateReplayCountsOnce`：重复重放不二次计数
- `TestUndo`：撤销、缺失 ID 报错、重复撤销报错
- `TestFaultInjectionRecovery`：3 个故障点 × 5 个操作位置注入后
  `Recover` 与无故障参照快照一致
- `TestRecoverMatchesLedgerRecompute`：健康存储上 `Recover` 为恒等
