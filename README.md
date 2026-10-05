# provenance

Go 查询库：对**有限非递归关系规则**（无递归 Datalog 风格 Horn 规则）求值，并为每个
输出元组保留**可替代来源集合**（why-provenance，最小见证集）。仅使用 Go 标准库。

## 模型

- `Fact`：基础（外延）关系的事实，输入至多 64 条（测试场景为至多 20 条）。
- `Rule`：`Head :- Body...`，项以 `?` 开头为变量，其余为常量；规则依赖图必须无环，
  否则 `New` 报错（不支持递归）。
- `Witness`：来源集合，编码为事实编号的位掩码（`uint64`）。

## 语义

- 每个输出元组保留其全部**最小**见证：任何是另一见证超集的来源集合都会被剔除
  （`minimizeWitnesses`，见 `provenance.go`）。
- **删除事实**（`Result.Without(i)`）仅撤掉包含该事实的见证；只要仍有替代见证，
  元组就保留。过滤后的见证仍保持最小性，因此 `Without` 可链式组合。

## 用法

```go
eng, err := provenance.New(facts, rules)   // 校验安全性与非递归性
res := eng.Query("q")                       // map: 元组 -> 最小见证集
sub := res.Without(3)                       // 删除第 3 条事实后的结果
```

## 验证

`provenance_test.go` 中的 `TestMinimalWitnessesMatchSubsetEnumeration` 使用 20 条事实，
枚举全部 2^20 = 1,048,576 个事实子集，用独立的朴素求值器（无 provenance）逐一求值，
核对每个输出元组的**最小导出子集**与引擎报告的最小见证完全一致。其余测试覆盖：
逐条删除事实后与重新求值对比、替代见证在删除后保留、超集见证剔除、递归规则拒绝等。

## 实测结果（go test ./...）

环境：go1.27.1 linux/amd64，2026-10-05。

```
=== RUN   TestMinimalWitnessesMatchSubsetEnumeration
--- PASS: TestMinimalWitnessesMatchSubsetEnumeration (30.04s)
=== RUN   TestDeleteFactRetractsOnlyContainingWitnesses
--- PASS: TestDeleteFactRetractsOnlyContainingWitnesses (0.00s)
=== RUN   TestAlternativeWitnessesSurviveDeletion
--- PASS: TestAlternativeWitnessesSurviveDeletion (0.00s)
=== RUN   TestSupersetWitnessesRemoved
--- PASS: TestSupersetWitnessesRemoved (0.00s)
=== RUN   TestRejectsRecursiveRules
--- PASS: TestRejectsRecursiveRules (0.00s)
=== RUN   TestRejectsTooManyFacts
--- PASS: TestRejectsTooManyFacts (0.00s)
=== RUN   TestRejectsUnsafeHeadVariable
--- PASS: TestRejectsUnsafeHeadVariable (0.00s)
PASS
ok  	provenance	30.075s
```
