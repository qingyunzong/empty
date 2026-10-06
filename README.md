# dagmetrics

DAG 派生指标库（仅 Go 标准库）。

## 设计

- **表达式**（`expr.go`）：仅整数常量、指标引用、`+`、`-`、`*` 与条件
  `cond(c, t, f)`（`c != 0` 取 `t` 否则取 `f`）。
- **DAG**（`graph.go`）：`NewGraph(sources, derived)` 构建图，校验重复定义、
  未知引用与环（DFS 三色标记），并产生拓扑序；构建时以全零源值发布初始状态。
- **增量重算**：`Update(corrections)` 将同一批多个源更正作为一次原子发布，
  版本号只递增一次。按拓扑序遍历，仅当某派生节点的至少一个依赖在本批实际
  改值时才重算；若重算结果与原值相同则提前截断，不再向下游传播（实际依赖
  变化闭包）。
- **版本与重算记录**：每个节点记录最后改值版本；每批发布记录
  `Batch{Version, Recomputed, Changed}`，可经 `Batches()` 查询。
- **对照**：`EvaluateAll()` 从当前源值全量求值，不改状态，用于与增量结果
  逐批对照。

## 测试结果

`go test ./...`（go1.27.1 linux/amd64）实际输出：

```
ok  	dagmetrics	0.037s
```

6 个测试全部通过，其中 `TestFuzzAgainstFullEvaluation` 对 200 个随机 DAG
各执行 20 批随机更正，逐批校验：增量快照 == 全量求值，且重算/改值集合 ==
独立复算的变化闭包。
