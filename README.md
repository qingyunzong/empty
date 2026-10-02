# mincostflow

带上下界、节点需求与整数费用的最小费用环流（允许负费用），支持增量修复、
割证书与可独立验证的最优性证明。仅依赖 Python 3.11 标准库。

## 模型约定

- 每条边有唯一 id、尾点、头点、整数下界 `lower`、上界 `upper`、费用 `cost`。
- 每个节点有整数需求 `demand`：`demand(v) > 0` 表示需要净流入；
  平衡约束为 `inflow(v) - outflow(v) == demand(v)`。
- 先判断可行性，再优化费用；费用优化绝不允许掩盖未满足的需求。

## 库用法

```python
from mincostflow import MinCostCirculation, verify

solver = MinCostCirculation()
solver.add_edge("e1", "s", "t", lower=0, upper=5, cost=2)
solver.apply_updates([
    {"op": "set_demand", "node": "s", "demand": -3},
    {"op": "set_demand", "node": "t", "demand": 3},
])
result = solver.solve(budget=None)   # budget 限制负环消除的增广次数
result.feasible, result.optimal      # 两个相互独立的状态
```

- 可行且最优：`result.flow`（边流量）+ `result.potentials`（节点势），
  可用 `verify.check_optimality(demands, edges, flow, potentials)` 独立核验
  （边界、平衡、所有正残量边的非负约化费用）。
- 预算耗尽：可行但 `optimal=False`，不输出势，绝不标记为最优。
- 不可行：`result.certificate` 给出 Hoffman 割证书
  （`demand(X) > upper_in(X) - lower_out(X)` 或
  `demand(X) < lower_in(X) - upper_out(X)`），
  由 `verify.check_cut_certificate` 重新求和核验。
- `solver.published` 保存最近一次已发布的可行结果；不可行更新与失败的
  事务（`UpdateError`）都不会改变已发布流与求解器状态。

批量更新（原子事务，任一非法则整批拒绝）：
`set_bounds` / `set_cost` / `set_demand` / `add_edge` / `remove_edge`。
容量下调使现有流越界时，`solve()` 沿残量网络把多余流量改道，而不是丢弃状态重建。

## CLI

```bash
python3.11 -m mincostflow solve spec.json     # 或从 stdin 读取
python3.11 -m mincostflow verify result.json
```

`solve` 输出每一步的 `feasible` 与 `optimal` 两个独立布尔状态、流量、势、
割证书以及 `published`（上一已发布可行版本）。`verify` 对模型独立复检
流量、最优性或证书，失败时退出码为 1。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

测试覆盖：小网络全流量枚举对照（可行性与费用）、负费用环、下界固定流、
需求同时迁移、削减关键边导致不可行、等成本不同流、暂停/恢复、证书与流量
篡改、事务原子性、CLI 双状态报告。
