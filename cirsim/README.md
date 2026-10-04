# cirsim

四值（0 / 1 / X / Z）电路模拟库，仅使用 Go 标准库。

## 模型

- **值**：`Zero`、`One`、`X`（未知/冲突）、`Z`（高阻）。门求值中 `Z` 按未知保守处理。
- **公开门表**：`gate.go` 中的 `notTable` / `andTable` / `orTable` / `xorTable` 为固定公开真值表；`NAND/NOR/XNOR` 为对应取反。`AND` 遇 0 得 0，`OR` 遇 1 得 1，`XOR` 含 X/Z 得 X。
- **同步轮次**：每轮用当前完整状态为所有门并行计算下一状态（`Circuit.step`），主输入保持不变；允许组合反馈环。

## 模拟结果（`Circuit.Simulate`）

- `Converged`：某一轮不再变化，`State` 为稳定值。
- `Cycle`：状态重复出现，`State` 为周期见证、`Period` 为周期长度（轮）。
- `Undecided`：轮次预算耗尽。

## 增量与全量

- `FullSimulate`：冷启动（门节点全 X）完整迭代。
- `IncrementalSimulate`：输入变化后以上一次状态热启动。
- 测试 `TestIncrementalMatchesFull` 对 3 位行波加法器枚举全部 64 个输入向量及其两两变化，逐一核对增量结果与完整迭代结果一致；`TestIncrementalMatchesFullWithFeedback` 对 NAND 锁存器（含反馈环）做同样核对。

## 测试结果（实际运行）

```
$ go test ./... -v
=== RUN   TestPublicGateTables
--- PASS: TestPublicGateTables (0.00s)
=== RUN   TestConvergedStableValues
--- PASS: TestConvergedStableValues (0.00s)
=== RUN   TestCycleWitness
--- PASS: TestCycleWitness (0.00s)
=== RUN   TestBudgetExhausted
--- PASS: TestBudgetExhausted (0.00s)
=== RUN   TestLatchFeedbackConverges
--- PASS: TestLatchFeedbackConverges (0.00s)
=== RUN   TestIncrementalMatchesFull
--- PASS: TestIncrementalMatchesFull (0.01s)
=== RUN   TestIncrementalMatchesFullWithFeedback
--- PASS: TestIncrementalMatchesFullWithFeedback (0.00s)
=== RUN   ExampleCircuit_Simulate
--- PASS: ExampleCircuit_Simulate (0.00s)
PASS
ok  	cirsim	0.015s
```
