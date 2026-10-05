# dagcache

构建规划库：在依赖 DAG 中选择共享中间产物缓存。缓存占用空间（预算约束），
命中缓存可节省后续重算；需求顺序固定（至多 20 次），目标是在缓存空间预算下
最小化总计算费。仅使用 Go 标准库。

## 模型

- `Graph`：计算节点 DAG。节点带 `Cost`（每次重算的计算费）、`Size`（缓存占用空间）、`Deps`（依赖下标）。
- 服务一次需求：目标节点若已缓存则费用为 0；否则递归重算未被缓存覆盖的祖先闭包，费用为实际重算节点 `Cost` 之和。
- 每步服务后可自由决定缓存内容：只能保留“已缓存或刚被重算”的产物，总空间 ≤ 预算；换入换出免费，只有计算费计入目标。

## 接口

- `OptimalPlan(demands, budget)`：对 (步数, 缓存位掩码) 做记忆化精确搜索，返回最小总计算费与每步缓存状态（`Plan.Steps`）。
- `FormatPlan`：把每步的需求、重算集合、当步费用、缓存内容、缓存占用、累计费用打印成表。
- `BruteForceCost`：无记忆化的完整状态穷举，作为独立参照实现，用于小图验证。
- `Simulate`：独立模拟器，按给定每步缓存决策重放需求序列并校验合法性，用于交叉核对规划结果。

## 验证

`dagcache_test.go` 在 300 组随机小图（2–7 节点、1–5 需求、预算 0–5）上断言：
`OptimalPlan` 总费用 == 完整状态穷举 == 模拟器重放费用，且每步缓存不超预算；
另含手算样例、零预算、需求次数上限（`ErrTooManyDemands`）、DAG 校验与非法决策拒绝等用例。

## 实测结果（go test ./...）

```
=== RUN   TestOptimalMatchesBruteForce
--- PASS: TestOptimalMatchesBruteForce (0.03s)
=== RUN   TestKnownExample
--- PASS: TestKnownExample (0.00s)
=== RUN   TestZeroBudgetForcesRecompute
--- PASS: TestZeroBudgetForcesRecompute (0.00s)
=== RUN   TestTooManyDemands
--- PASS: TestTooManyDemands (0.00s)
=== RUN   TestValidate
--- PASS: TestValidate (0.00s)
=== RUN   TestSimulateRejectsInvalidDecisions
--- PASS: TestSimulateRejectsInvalidDecisions (0.00s)
PASS
ok  	dagcache	0.037s
?   	dagcache/cmd/dagcache-demo	[no test files]
```

## 运行示例

```
go run ./cmd/dagcache-demo
```

输出每步缓存状态表，并与完整状态穷举参照值比对（match=true）。
