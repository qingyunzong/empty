# cfglib — 版本化控制流图支配分析库

纯 Go 标准库实现，无第三方依赖。

## 功能

- **增删边维护入口支配树**：`Graph.AddEdge` / `Graph.RemoveEdge` 产生新版本，
  `Analyze()` 用 Cooper–Harvey–Kennedy 迭代算法重建支配树（`dom.go`）。
- **不可达节点单列**：`Analysis.Unreachable()` 返回入口不可达节点，
  它们不参与支配树与各查询。
- **最近共同支配**：`Analysis.NearestCommonDominator(x, y)` 按支配树深度爬升求 LCA。
- **支配边界**：`Analysis.DominanceFrontier(n)`，Cytron 算法；
  入口节点在环上（idom(entry)=entry）的情形做了定义级修正。
- **旧版本可读**：`Graph` 不可变，每次有效变更版本号 +1 并深拷贝，
  旧版本及其分析结果可随时重读（见 `TestOldVersionsRemainReadable`）。
- **支配集合证据**：`Analysis.String()` 逐节点输出
  `idom`、完整支配集合 `doms`、支配边界 `DF`，不可达节点标注 `unreachable`。

## 独立核对

`verify.go` 是与支配树实现零共享代码的朴素实现，基于**删节点可达法**定义：
d 支配 n 当且仅当删除 d 后 n 从入口不可达。由此派生朴素支配边界与
最近共同支配。`crosscheck_test.go` 对确定性样例及 150 组随机小图
（每组 12 步随机增删边，逐步核对）比较两种实现的：

- 可达/不可达集合
- 每节点完整支配集合
- 每节点直接支配者
- 每节点支配边界
- 全部节点对的最近共同支配

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64

```
$ go test ./... -count=1
ok  	cfglib	2.658s
```

```
--- PASS: TestCrossCheckDeterministicGraphs (0.00s)
--- PASS: TestCrossCheckRandomMutations (2.65s)
--- PASS: TestDominatorTreeDiamond (0.00s)
--- PASS: TestDominanceFrontierDiamond (0.00s)
--- PASS: TestDominanceFrontierLoop (0.00s)
--- PASS: TestNearestCommonDominator (0.00s)
--- PASS: TestUnreachableListedSeparately (0.00s)
--- PASS: TestEdgeAddRemoveMaintainsDomTree (0.00s)
--- PASS: TestOldVersionsRemainReadable (0.00s)
--- PASS: TestEvidenceDump (0.00s)
--- PASS: Example (0.00s)
PASS
```

另运行 `go test ./... -race -count=1` 通过（14.262s），`go vet ./...` 无告警。

## 用法

见 `example_test.go`：

```go
g1 := cfglib.New("A").
    AddEdge("A", "B").AddEdge("A", "C").
    AddEdge("B", "D").AddEdge("C", "D")
g2 := g1.RemoveEdge("C", "D") // 新版本；g1 保持可读

a := g2.Analyze()
fmt.Print(a.String())                 // 逐节点支配证据
ncd, _ := a.NearestCommonDominator("B", "D")
df := a.DominanceFrontier("B")
bad := a.Unreachable()
```
