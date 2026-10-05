# automata

Go 标准库实现的 ε-NFA 自动机库。

- `NFA`：整型状态、字节符号边、ε 边；`Eval` 子集模拟求值。
- `Compare(a, b, budget)`：子集对 BFS 比较两个语言。返回
  `Equivalent` / `Different` / `Unknown`（预算耗尽且搜索未闭合时）。
  差异串为最短、同长度中字节序最小；BFS 按层扩展且符号按字节升序入队保证该性质。
- `Certificate`：差异串对应的子集转移链，`Verify` 可独立重放校验。
- `FindDiffBrute(a, b, maxLen)`：按长度再字节序枚举短串，用于交叉核对。

## 测试结果（实际运行）

```
$ go test ./... -v
=== RUN   TestEvalEpsilon                --- PASS
=== RUN   TestEquivalentWithEpsilon      --- PASS
=== RUN   TestDifferentShortestWitness   --- PASS
=== RUN   TestByteOrderMinimalWitness    --- PASS
=== RUN   TestEmptyWitness               --- PASS
=== RUN   TestBudgetExhaustedUnknown     --- PASS
=== RUN   TestBudgetSufficient           --- PASS
=== RUN   TestCertificateChain           --- PASS
=== RUN   TestCrossCheckRandomSmall      --- PASS
PASS
ok  	automata	0.014s
```
