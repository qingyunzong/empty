# cfgdom — 版本化控制流图支配分析库

仅依赖 Go 标准库。

## 功能

- **增删边后维护入口支配树**：`Graph.AddEdge` / `RemoveEdge` / `AddNode`
  每次变更提交一个新的不可变 `Version`，支配分析随版本一并重算。
- **不可达节点单列**：`Version.Unreachable()` 返回从入口不可达的节点，
  这些节点不参与支配树，支配查询对其返回 `ok=false`。
- **查询**：
  - `NCD(a, b)` — 最近共同支配（支配树上的 LCA）；
  - `DominanceFrontier(n)` — 支配边界（Cytron 定义）；
  - `Dominators(n)` / `IDom(n)` / `Children(n)` / `Dominates(d, n)`。
- **旧版本可读**：`Version` 不可变，历史版本随时可查询，
  `Graph.Versions()` 返回全部版本。
- **支配集合证据**：`Version.Evidence()` 输出每个可达节点的完整支配
  集合及不可达节点清单，格式稳定（排序后文本）。
- **独立核对**：`Version.Verify()` 用定义性的「删节点可达法」
  （删除 d 后 n 不可达 ⟺ d 支配 n）重新计算支配集合，并用独立 BFS
  重核可达划分，与维护结果逐节点比对；适用于小图。

## 算法

- 支配树：Cooper–Harvey–Kennedy 迭代算法（RPO + 手指交集）。
- 支配边界：沿 idom 链的边上溯，另加入口回边/自环特判
  （n 支配自身前驱时 n ∈ DF(n)）。
- 测试含固定种子随机小图：每个版本都过 `Verify()`，且 NCD 与
  支配边界分别与基于支配集合的暴力定义比对。

## 运行测试

```sh
go test ./...
```
