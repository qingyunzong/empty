# impact

测试影响分析库：读取文件级依赖图与变更集合，为每个测试计算其受变更影响的
最短依赖路径；多条最短路径并列时取节点 ID 序列字典序最小者。

## 规则

- 分析图为旧图与新图的**合并图**：新图中被删除的节点仍保留其在旧图中的
  出边与入边影响（`Merge`）。
- 变更目标 = `changed` ∪ `deleted`（删除的文件本身也是变更）。
- 逐测试 BFS：所有边权为 1，按层推进保证最短；每层每节点只保留字典序
  最小路径，实现平局时 ID 序列最小；visited 集合保证循环安全。
- `reference.go` 提供穷举所有简单路径的参考实现，测试中在旧图、新图、
  合并图三图上与 BFS 交叉核验。

## 输入格式（JSON）

```jsonc
// 依赖图：{"edges": {"文件": ["直接依赖", ...]}}
{"edges": {"svc/a.go": ["repo/b.go"], "repo/b.go": ["db/c.go"]}}
// 变更集
{"changed": ["db/c.go"], "deleted": ["legacy/x.go"]}
// 测试列表
["svc/a_test.go"]
```

## 用法

```go
oldGraph, _ := impact.LoadGraphFile("old.json")
newGraph, _ := impact.LoadGraphFile("new.json")
cs, _ := impact.LoadChangeSetFile("changes.json")
tests, _ := impact.LoadTestsFile("tests.json")
for _, r := range impact.Analyze(oldGraph, newGraph, cs, tests) {
    // r.Test, r.Affected, r.Path（最短路径，含两端；未受影响为 nil）
}
```

## 测试

```sh
go test ./...
```
