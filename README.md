# netflow

动态有向图最大流/最小割库，仅依赖 Go 标准库。

## 功能

- 非负整数容量的有向多重图，平行边以唯一 `EdgeID` 区分
- `AddEdge` / `RemoveEdge` 增删边，`Undo` 撤销最近更新，`Version` 跟踪版本
- `MaxFlow(s, t)` 用 Edmonds-Karp 计算最大流，返回：
  - 流值
  - 每条边的可行流（满足容量约束与流量守恒）
  - 最小割证书 `Cut`（残量网络中源点可达集），割容量等于流值

## 测试

`go test ./...` 实测结果（go1.27.1, linux/amd64）：

```
=== RUN   TestKnownNetwork
--- PASS: TestKnownNetwork (0.00s)          // CLRS 经典网络，最大流 = 23
=== RUN   TestParallelEdges
--- PASS: TestParallelEdges (0.00s)         // 平行边按 ID 独立计费
=== RUN   TestUndoRestoresFlow
--- PASS: TestUndoRestoresFlow (0.00s)      // 撤销增/删边后流值恢复
=== RUN   TestRandomVersionsAgainstBruteForce
--- PASS: TestRandomVersionsAgainstBruteForce (0.02s)
=== RUN   TestDisconnectedAndZeroCapacity
--- PASS: TestDisconnectedAndZeroCapacity (0.00s)
PASS
ok  	netflow	0.072s
```

随机测试在 2–6 个顶点的小图上随机执行增/删/撤销，
对**每个版本**校验：流可行性（容量约束 + 守恒）、
割容量等于流值、并枚举全部 2^(n-2) 个割核对最小割容量等于最大流值。
