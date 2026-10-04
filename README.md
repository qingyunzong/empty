# cacheplan

构建规划库：在依赖 DAG 上为共享中间产物选择缓存内容。缓存占用空间、
节省后续重算；需求顺序固定（至多 20 次），在缓存空间预算下最小化总计算费。

## 模型

- `Graph`：节点带 `Cost`（重算费）、`Size`（缓存占位）、`Deps`（依赖下标）。
- 每步服务一个需求节点：其传递闭包中未缓存的节点全部重算，费用为它们的
  `Cost` 之和；算出的产物与已有缓存共同构成可缓存集合。
- 每步结束后可从可缓存集合中任选子集保留，总 `Size` 不得超过预算。
- `Optimize` 用缓存状态位掩码上的精确动态规划求最小总费用，并输出每步
  缓存状态（`Plan.Steps`，`Plan.String` 可打印）。
- `BruteForce` 不做记忆化、穷举全部合法缓存决策，用于小图上完整状态
  搜索验证 DP 结果。

## 使用

```go
p, err := cacheplan.Optimize(graph, demands, budget)
fmt.Print(p.String(graph)) // 每步：需求、重算集合、步骤费用、缓存状态
```

演示：`go run ./cmd/plandemo`

## 限制

- 需求序列长度 ≤ `MaxDemands`（20）。
- 节点数 ≤ 24（状态按位掩码枚举）。

## 测试

`go test ./...`：手算精确用例、预算/空缓存边界、输入校验，以及 300 组
随机小图上 DP 与暴力全状态搜索的对拍（含每步缓存状态不变量校验）。

实测结果（go1.27.1 linux/amd64）：

```
ok  	cacheplan/cacheplan	0.036s
?   	cacheplan/cmd/plandemo	[no test files]
```
