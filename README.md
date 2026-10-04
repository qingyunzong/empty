# mcfcert — 最小费用流证书验证器与有预算修复器

纯 Python 3.11 标准库实现，无第三方依赖。用于调度平台校验外部提交的
最小费用流方案（证书），并在发现错误时定位最小修复，而不是只返回失败。

## 数据模型

网络（JSON）：

```json
{
  "nodes": ["s", "a", "t"],
  "edges": [
    {"id": "e1", "tail": "s", "head": "a", "lower": 0, "upper": 4, "cost": 1}
  ],
  "demands": {"s": -4, "t": 4}
}
```

- 容量、上下界、费用、需求均为整数；`demands[v] > 0` 表示节点 `v` 需要
  净流入 `demands[v]`（inflow − outflow == demand）。

证书（JSON）：

```json
{
  "flows": {"e1": 4},
  "potentials": {"s": 0, "a": 1, "t": 2},
  "declared_cost": 4
}
```

## 验证器（独立核验，不调用修复器）

`Verifier(network).verify(certificate)` 逐项检查：

- **capacity**：每条边流量为整数且 `lower <= x <= upper`，输出违规边；
- **conservation**：每个节点散度等于需求，输出违规节点（required/actual）；
- **demand**：需求向量全局平衡（总和为 0）；
- **cost**：实际总费用与声明费用一致；
- **reduced_costs**：残量图上每条前向/后向残量边的约化费用非负，
  输出违规残量边及方向；
- **negative_cycle**：在残量图上用 Bellman-Ford 独立找出负费用环，
  输出环上的边、方向与环费用（容量被违反时残量图无定义，跳过并注明）。

验证器对每次调用构造全新裁决字典，不保存任何跨证书状态：批量验证共享
网络的不同证书时，上一份非法证书不会污染下一份结果（有专门测试）。

## 修复器（三级字典序目标 + 预算 + 检查点）

`Repairer(network).repair(base_flows, budget=None, checkpoint=None)` 寻找
可行流，依次最小化：

1. 被修改的边流量个数；
2. 与原流的 L1 距离；
3. 修复后总费用。

实现：第 1 级按子集大小枚举"可自由修改的边集合"（其余边固定在原值，
用最大流判定可行性）；第 2、3 级合并为一次加权最小费用流——每条自由边
重定基到 `clamp(x0, lower, upper)`，前向残量边费用 `W + c`、后向
`W − c`（`W = 费用值域 + 1`），使单目标最优恰好等于 (L1, cost) 字典序
最优。最小费用流用"最大流求可行 + 负环消去"，可处理负费用。

- **预算**：`budget` 限制搜索步数（每次子集可行性测试 / 最小费用流求解
  计 1 步）。预算耗尽时返回 `status: "budget_exhausted"`、目前最佳可行
  修复、已证明的修改数下界（`lower_bound_modifications`），且
  `optimal: false`——不声称全局最优。
- **检查点**：`checkpoint` 回调在每个阶段边界收到进度字典（事件、已用
  步数、下界、当前在位修复）。
- **不可行**：网络本身无可行流时返回 `status: "infeasible"` 与割证书
  （Hoffman 割：最小割不可达侧节点集合，其净需求超过跨割最大净流入，
  给出 `deficit`）。

## CLI

```bash
python3.11 -m mcfcert verify network.json certificate.json
python3.11 -m mcfcert repair network.json certificate.json [--budget N] [--verbose]
```

退出码：`verify` 合法 0 / 非法 1；`repair` 最优 0 / 预算耗尽 2 /
不可行 3；输入格式错误 4。结果以 JSON 输出到 stdout，`--verbose` 把
修复检查点打到 stderr。

## 独立枚举交叉核对

`mcfcert/enumerator.py` 对小网络穷举所有界内整数流，独立计算三级目标的
参考最优与最小费用，用于测试核对修复器的最优性状态与结果（与修复器搜索
逻辑零共享）。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖场景：守恒正确但费用非最优（残量负环暴露）、负费用环输出、单边超容
引发连锁修复、同样修改数不同 L1 距离、L1 并列时费用决胜、修改数优先于
费用、不可行下界（割证书）、篡改势、篡改声明费用、需求不平衡、非整数/
缺失流量、预算耗尽的下界与最佳可行修复、检查点序列、批量验证隔离性，
以及全部修复用例对独立枚举器的交叉核对。

实测结果（2026-10-04，Python 3.11.16）：

```
Ran 36 tests in 0.437s
OK
```
