# depimpact

分析文件级依赖图与变更集合，输出每个测试受影响的最短依赖路径。

## 约定

- 边 `from -> to` 表示 **from 依赖 to**；影响沿反向（被依赖方向）传播。
- 分析在**旧图与新图的并集（双图合并）**上进行：被删除的节点仍保留旧图中的边，
  其影响继续参与传播。
- 对每个测试，从所有变更节点做多源 BFS，取最短路径；长度并列时取
  **ID 序列字典序最小**者。逐层结算保证循环安全（每节点仅结算一次）。

## 输入格式

图（old/new 同构）：

```json
{"nodes": ["a"], "edges": [{"from": "a", "to": "b"}]}
```

变更集合：

```json
{"changed": ["b"], "deleted": ["c"], "tests": ["test_a"]}
```

`deleted` 为显式删除列表；`DeletedNodes` 还会并上"旧图有、新图无"的节点。

## 使用

库：

```go
impacts := depimpact.Analyze(oldGraph, newGraph, changeSet) // []Impact，按测试 ID 排序
```

CLI：

```sh
go run ./cmd/depimpact -old old.json -new new.json -changes changes.json
```

## 测试

```sh
go test ./...
```

测试包含一个独立的**逐测试参考实现**（`referenceImpact`，基于
(distance, path) 优先队列的 Dijkstra 式搜索，与主实现的分层 BFS 不共享代码），
在固定样例与 300 组合环随机双图上对 `Analyze` 做交叉核验。
