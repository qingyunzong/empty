# schedsolve

有限时间预算下的排期诊断：整数差分约束 + 互斥时间区间的组合求解器，
严格区分三种结论 —— `sat`（已找到解）、`unsat`（无解）、`unknown`
（预算耗尽，仍未决定）。纯 Python 3.11 标准库，无第三方依赖。

## 模型

- 任务 `0..n-1`，每个任务有正整数持续时长 `durations[t]` 与整数开始时间变量 `x_t`。
- 差分约束 `x_v - x_u <= c`（整数界，可为负）。
- 互斥对 `(i, j)`：两任务区间不得重叠，即
  `x_i + d_i <= x_j` 或 `x_j + d_j <= x_i`，由求解器分支选择先后顺序。

## 求解器架构

- **差分部分**（`schedsolve/diffcon.py`）：增量维护势函数 `pi`（即一组可行
  整数解）。加边时从边头做最短路式收紧；收紧路径回到自身即暴露负环，
  产出可重放的负环证书（有序边列表 + 权和 < 0）。
- **撤销**：所有势修改记录在 trail 上，`push()`/`pop()` 可嵌套。`pop()`
  恢复势函数、删除该层加入的边、并清除依赖这些边的冲突证书 —— 不只是
  删边。松弛预算在添加中途耗尽时，整个添加（含边本身）回滚。
- **互斥部分**（`schedsolve/solver.py`）：显式选择点栈的迭代 DFS。每个
  未决互斥对分支两种先后次序（各化为一条差分边）。搜索前沿（含已完成
  的冲突子树）可序列化为 JSON，之后在同一或其他求解器实例上恢复继续。
- **预算**：松弛步数与分支节点数分别计费（`relax_budget` /
  `branch_budget`）。任一耗尽即返回 `unknown`，附当前候选时间表（仅满足
  已断言约束 —— 绝不从局部一致推断全局可行）与可恢复的前沿。
- **结论证据**：
  - `sat`：完整整数时间表（所有任务的开始时间，平移到最小为 0）。
  - `unsat`：可独立重放的分支冲突树；每个分支节点覆盖两种次序，每个
    叶子是一个负环证书。
  - `unknown`：候选时间表 + 搜索前沿。

## 证据检查器（`schedsolve/checker.py`）

完全独立实现，不复用求解器的任何传播/剪枝逻辑：

- `verify_schedule`：直接逐条代入检查全部差分约束与互斥区间。
- `verify_conflict_tree`：沿树重放分支决策，逐叶验证负环证书（边必须
  首尾相接成环、权和为负、每条边由基础约束或路径上的分支决策正名），
  并要求每个分支节点两个子树齐全。
- `verify_candidate`：校验 `unknown` 的候选满足基础约束与前沿路径上的
  分支决策。

## 有界枚举核对（`schedsolve/brute.py`）

对小实例在 `[0, horizon]` 内枚举整数时间表（`safe_horizon` 给出完备
上界），测试中与求解器结论交叉核对。

## JSON CLI

```bash
python3.11 -m schedsolve solve  instance.json [--relax-budget N] [--branch-budget N] [--frontier f.json]
python3.11 -m schedsolve check  instance.json result.json     # 退出码 0=有效 1=无效
python3.11 -m schedsolve brute  instance.json [--horizon H]
```

实例格式：

```json
{
  "n_tasks": 3,
  "durations": [2, 2, 1],
  "constraints": [{"u": 0, "v": 2, "c": 6, "uid": "k0"}],
  "disjuncts": [[0, 1], [1, 2]]
}
```

求解结果（按状态三选一）：`{"status": "sat", "schedule": {...}}`、
`{"status": "unsat", "conflict_tree": {...}}`、
`{"status": "unknown", "candidate": {...}, "frontier": {...}}`，均附
`stats`（relax_steps / branch_nodes / conflicts）。

## 库用法

```python
from schedsolve import Solver

solver = Solver(2, [2, 3])
solver.add_constraint(0, 1, 0)      # x1 - x0 <= 0
solver.add_constraint(1, 0, 0)      # x0 - x1 <= 0
solver.add_disjunct(0, 1)
result = solver.solve(relax_budget=100, branch_budget=10)
print(result.status)                # "unsat"（差分可行但互斥组合无解）

solver.push()                       # 嵌套撤销
solver.add_constraint(0, 1, -5)
solver.pop()                        # 恢复收紧与冲突依赖

partial = solver.solve(branch_budget=1)     # 预算耗尽
final = solver.solve(frontier=partial.frontier)  # 从保存的前沿恢复
```

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：差分局部可行但互斥组合无解、撤销后重新可行、同一分支反复暂停
恢复、预算恰在冲突前结束、无效证书（断环 / 非负权 / 未知 uid / 残缺
冲突树）、输入错误回滚、随机小实例与有界枚举交叉核对、CLI 端到端。

最近一次运行结果（Python 3.11.16）：**46 个测试全部通过（OK）**。
