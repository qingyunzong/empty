# mincostflow

带上下界、节点需求和整数费用的最小费用环流库（Python 3.11 标准库，无第三方依赖）。

## 模型

- 有向图，每条边有唯一 `id`、整数下界 `lo`、上界 `hi`（`lo <= hi`）和整数费用 `cost`（允许负费用）。
- 每个节点有整数需求 `d(v)`：可行流满足 `inflow(v) - outflow(v) == d(v)`，需求总和必须为 0。
- 先判断可行性，再优化费用——不会用费用最小来掩盖不满足的需求。

## 求解器

`MinCostCirculation(nodes, edges, demands)`：

- `solve(budget=None)`：从**当前流和残量网络**增量修复（不丢弃状态重建）。
  1. 可行性阶段：越界流先钳回界内，不平衡沿残量网络用最大流修复（容量下降使现有流超界时同样沿残量调整）。
  2. 优化阶段：Bellman-Ford 消负环，直到用节点势证明最优。
- 返回 `SolveResult`，`feasibility` 与 `optimality` 是两个独立状态：
  - `feasibility`: `feasible` / `infeasible` / `unknown`（预算在可行性阶段耗尽）
  - `optimality`: `optimal` / `not_proven` / `infeasible` / `unknown`
- 预算耗尽返回可行但 `not_proven`，**绝不**标记 `optimal`；再次调用 `solve` 即暂停恢复。
- 不可行时返回割证书：节点集合 `X` 满足 Hoffman 不等式 `d(X) > u(δ⁻(X)) - l(δ⁺(X))`。
- `published_result()`：上一已发布可行版本；不可行的求解不会覆盖它。
- `apply_updates(edge_updates, demand_updates)`：批量修改上下界/费用/需求，先整体校验再提交；任何错误（未知边 id、`lo > hi`、需求和不为 0、非整数）都抛出 `UpdateError` 且已发布流与缓存不变。

## 独立验证器

`mincostflow.verify` 只接受纯数据，与求解器无共享状态：

- `verify_flow(nodes, edges, demands, flows)`：检查所有边 `lo <= f <= hi` 与节点平衡。
- `verify_optimality(..., flows, potentials)`：额外检查所有正残量边的非负约化费用
  （`f < hi ⇒ c + π(u) - π(v) >= 0`，`f > lo ⇒ c + π(u) - π(v) <= 0`）。
- `verify_cut(nodes, edges, demands, certificate)`：核验不可行割证书不等式。

`mincostflow.brute.brute_force` 枚举小网络每条边的有限整数流，给出可行性、最小费用与最优流个数，作为测试对照。

## JSON CLI

```
python3.11 -m mincostflow input.json     # 或从 stdin 读取
```

输入：`{"nodes": [...], "edges": [{"id","tail","head","lo","hi","cost"}],
"demands": {...}, "operations": [...]}`，操作为 `{"op":"solve","budget":N}`、
`{"op":"update","edges":{...},"demands":{...}}`、`{"op":"published"}`。
输出每个操作的结果；`solve` 结果中 `feasibility` 与 `optimality` 独立报告，
失败的 `update` 报告 `ok:false` 且不改变求解器状态。

## 测试

```
python3.11 -m unittest discover -s tests -v
```

覆盖：负费用环、下界固定流、需求同时迁移、削减关键边导致不可行、等成本不同流、
暂停恢复、证书/流/势篡改、事务错误原子性、CLI 双状态报告，以及 200 组随机小网络
对照暴力枚举的可行性与费用（另离线浸泡 4500 组随机用例含增量更新与随机预算，全部一致）。

最近一次实际运行结果：

```
Ran 28 tests in 0.8s
OK
```
