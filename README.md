# schcount — 严格预算下的精确解计数器

对**有限整数域 + 允许元组表约束**的问题精确计数可行解数量。面向排班分析
场景：在严格的预算上限内给出可行方案数的可信区间 `[confirmed_lower,
certified_upper]`，支持在任意一次值支持检查后暂停、序列化检查点、并在新
进程中恢复。只有当下界与上界相等时才输出精确结果（`exact`）；预算耗尽
时绝不声称"无解"或给出精确值。

仅依赖 Python 3.11 标准库；测试使用 `unittest`。

## 问题模型

```json
{
  "variables": {"x": [0, 1, 2], "y": [0, 1, 2]},
  "constraints": [
    {"id": "c1", "scope": ["x", "y"], "tuples": [[0, 1], [1, 2]]}
  ]
}
```

每个变量取有限整数域；每个表约束列出其作用域（scope）内允许的元组。

## 命令行（JSON CLI）

```bash
# 求解：预算以"值支持检查次数"计；缺省不限
python3.11 -m schcount solve problem.json --budget 100 \
    --checkpoint cp.json --certificate cert.json --result result.json

# 从检查点恢复（可以是全新进程），再追加 100 单位预算
python3.11 -m schcount resume cp.json --budget 100 \
    --checkpoint cp.json --certificate cert.json

# 独立证书检查（退出码 0=接受，1=拒绝）
python3.11 -m schcount verify cert.json
```

结果 JSON：

```json
{
  "confirmed_lower": 0,      // 已确认的下界
  "certified_upper": 9,      // 可验证的上界
  "complete": false,         // 上下界是否相等
  "exact": null,             // 仅当 complete 时给出精确解数
  "support_checks": 100      // 已消耗的预算（值支持检查次数）
}
```

## 库用法

```python
from schcount import Constraint, Problem, Solver, verify_certificate

p = Problem()
p.add_variable("x", [0, 1, 2])
p.add_variable("y", [0, 1, 2])
p.add_constraint(Constraint("c1", ("x", "y"), [(0, 1), (1, 2)]))

s = Solver(p)
result = s.solve(budget=10)          # 可随时暂停
checkpoint = s.to_checkpoint()       # 可 JSON 序列化的检查点
s2 = Solver.from_checkpoint(checkpoint)
result = s2.solve()                  # 恢复并跑完
cert = s2.certificate()              # 可独立验证的证书
ok, reason = verify_certificate(cert)
```

## 设计要点

- **传播 + 确定性分支**：AC-3 风格的弧一致性传播（每个表约束对每个变量
  做值支持检查，每次检查计 1 单位预算），随后按（域大小, 变量名）确定性
  选变量、按值排序分支。
- **分量因子化**：每次传播后按约束图的连通分量拆分，各分量独立计数后
  相乘（`product` 节点）。
- **两两不交的前沿**：`sum` 节点的子节点把某变量的当前域按值逐一划分，
  因此未探索前沿是两两不交的赋值空间。上界由前沿叶子的当前域大小乘积
  （可验证界）经 sum/product 结构汇总而成；下界只累计已完全探索的子树，
  因此暂停在传播内部也不会重复计数。
- **可在任意一次检查后暂停**：传播工作队列项精确到
  `[约束, 变量, 待查值, 已保留值, 元组位置]`，每消耗 1 单位预算都推进
  可序列化的状态，1 单位预算反复恢复也保证单调推进。
- **规范缓存**：子问题缓存键 = 精确变量域 + 约束内容的规范形；缓存项
  携带变量域、约束版本及 `约束id → 内容摘要` 映射。增加或撤销约束后，
  仅当当前问题在这些变量上的约束集与缓存项的证明依据完全一致时才复用。
  问题约束版本变化时搜索树整体重建（缓存仍按项校验复用）。
- **独立证书检查器**（`schcount/checker.py`）：不依赖求解器内部逻辑，
  独立重算 AC 闭包，验证前沿覆盖性（分支值恰好划分父域）、不相交性、
  分量划分、已确认解（单例赋值满足全部约束；其余 solved 节点暴力重数）
  以及叶子界等于域乘积。任何篡改都会导致拒绝。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：≤7 变量、每域 3 值的全枚举对照并在每次暂停时核对上下界；分量
合并与再次拆分；约束撤销使解数上升；缓存键碰撞；预算 0 与恰好完成；
反复 1 单位预算恢复（含新进程 CLI 恢复）；被篡改证书必须拒绝。
最近一次运行结果见 `test-results.txt`。
