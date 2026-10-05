# tagtree

标签树事件统计库（仅使用 Go 标准库）。

## 语义

- 标签构成一棵树（`Tree`），节点用 int ID 标识，支持 `AddEdge` / `RemoveEdge`。
- 一条事件可打多个标签节点（`Library.AddEvent`），标签原样存储。
- 在祖先节点汇总时，每条事件最多计一次（`Count` 对事件去重）。
- `RemoveEdge` 只改变子树归属（汇总成员关系），从不改写事件上的原始标签。
- `Evidence(node)` 输出事件贡献证据：每条贡献事件及其命中该子树的原始标签（`Via`）。

## 测试

`tagtree_test.go` 包含：

- 祖先去重、证据 Via 列表、删边后归属变化但标签不变的单元测试；
- 树编辑与事件校验的错误路径测试；
- `TestSmallTreeReachabilityCrossCheck`：200 组随机小树（2–8 节点、随机多标签事件、
  逐条随机删边），每步用独立的逐事件可达性重算（沿父链逐跳走查）作为 oracle，
  核对每个节点的 `Count` 与 `Evidence`，并校验原始标签始终不变。

## 实际测试结果

```
$ go test ./...
ok  	tagtree	0.384s
```

（Go 1.27.1 linux/amd64，2026-10-06；6 个测试全部 PASS，含 200 组随机核对。）
