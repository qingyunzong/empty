# 血缘循环与递归查询

一个可直接接入 Go 血缘图查询组件的数据目录实现，支持递归 CTE、自引用视图、作业循环，以及并发安全的增量边更新。

## 核心语义

- 节点表示 table、view、job、CTE、dataset 等数据资产。
- 边按数据流方向表示：`From` 是上游，`To` 是下游。
- 上游查询沿入边遍历，下游查询沿出边遍历。
- 深度按边数计算：`0` 只返回起点，负数表示不限深度。
- 遍历状态使用 `(节点, 边类型)` 组合，而不是只用节点。同一节点通过不同边类型到达时会继续探索。
- 当前路径上再次遇到相同 `(节点, 边类型)` 即判定为环；保留首次环证据，并按规范化环签名去重。
- 回到查询起点视为闭环（起点没有入边类型，因此任意类型回到起点都保留环证据）。
- 每次变更发布一个不可变快照；查询只读取一个快照，因此单次查询不会混用两个版本。

## 快速开始

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0144"
)

func main() {
	c := dataeng.NewCatalog()
	_ = c.AddNodes(
		dataeng.Node{ID: "raw_orders", Type: dataeng.NodeTable},
		dataeng.Node{ID: "clean_orders", Type: dataeng.NodeView},
		dataeng.Node{ID: "daily_report", Type: dataeng.NodeView},
	)
	_ = c.AddEdges(
		dataeng.Edge{From: "raw_orders", To: "clean_orders", Type: dataeng.EdgeDerivedFrom},
		dataeng.Edge{From: "clean_orders", To: "daily_report", Type: dataeng.EdgeDerivedFrom},
	)

	res, err := c.Upstream("daily_report", 3)
	if err != nil {
		panic(err)
	}
	fmt.Println("snapshot version:", res.Version)
	for _, p := range res.Paths {
		fmt.Println(p.Nodes)
	}
}
```

依赖声明也可以直接写成 `downstream depends on upstream`：

```go
err := c.AddDependency("daily_report", "clean_orders", dataeng.EdgeDependsOn)
```

## 环查询

```go
res, _ := c.Upstream("job_a", dataeng.UnlimitedDepth)
for _, cy := range res.Cycles {
	// Nodes 首尾相同，Edges/EdgeTypes 长度等于环的边数。
	fmt.Println(cy.Nodes, cy.EdgeTypes, cy.Depth)
}
```

自引用视图和递归 CTE 都是普通的自环或状态环；作业循环也使用同一套检测逻辑，不需要特殊分支。不同边类型构成的环不会被节点级去重误判，环证据会保留第一次发现的路径。

## 版本快照

```go
import "context"

v1 := c.Version()
_ = c.AddEdge(dataeng.Edge{From: "raw_orders", To: "audit", Type: dataeng.EdgeFeeds})
v2 := c.Version() // v1 + 1

old, _ := c.SnapshotAt(v1) // v1 不可变快照
res, _ := c.QueryAt(context.Background(), v1, dataeng.Query{
	Start:     "daily_report",
	Depth:     3,
	Direction: dataeng.Upstream,
})
fmt.Println(old.EdgeCount(), res.Version, v2)
```

批量边修改在同一个新版本中原子生效：

```go
_, err := c.ApplyEdgeUpdates(
	dataeng.EdgeUpdate{Edge: dataeng.Edge{From: "a", To: "b", Type: dataeng.EdgeFeeds}},
	dataeng.EdgeUpdate{Op: dataeng.EdgeOpRemove, Edge: dataeng.Edge{From: "x", To: "y", Type: dataeng.EdgeFeeds}},
)
```

默认保留全部历史版本；可用 `dataeng.WithHistoryLimit(n)` 或 `dataeng.WithoutVersionHistory()` 控制内存占用。

## JSON 数据目录

```json
{
  "version": 7,
  "nodes": [
    {"id": "t", "type": "table", "name": "T"},
    {"id": "v", "type": "view", "name": "V"}
  ],
  "edges": [
    {"from": "t", "to": "v", "type": "derived_from"}
  ]
}
```

导入与查询：

```go
c, err := dataeng.LoadJSON(file)
res, err := c.Upstream("v", 4)
```

加载器同时接受 `kind` 作为 `type` 的别名、`source`/`target` 或 `upstream`/`downstream` 作为 `from`/`to` 的别名，便于接入既有目录导出。边先于节点出现时，会自动生成 `unknown` 类型的占位节点。

## 验证

```bash
go test -race ./...
```
