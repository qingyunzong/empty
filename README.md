# mcflow — 最小费用流证书验证器与有预算修复器

纯 Python 3.11 标准库实现，无第三方依赖。

## 功能

- **验证器** (`mcflow.verifier.verify`)：独立逐项核验外部提交的证书，不调用修复器的任何优化结果：
  1. 容量与整数性（逐边报告 `capacity` / `non_integer_flow` / `missing_flow`）
  2. 守恒与需求（逐节点报告 `conservation`，含期望值与实际值）
  3. 声明总费用（`cost_mismatch`，含声明值与重算值）
  4. 残量边约化费用（对提交的节点势逐边报告 `reduced_cost`，含方向）以及
     残量网络中的负费用环（`negative_cycle`，给出环上每条边的方向与环总费用）
- **修复器** (`mcflow.repairer.repair`)：按字典序三级目标修复非法流——
  ① 被修改边数最少 → ② 与原流的 L1 距离最小 → ③ 总费用最小。
  - 网络本身不可行时输出割证书（节点集合 T 满足 demand(T) > 入T容量 − 出T下界），
    可由 `verify_cut_certificate` 独立核验。
  - 支持修复预算（`budget` = 求解尝试次数上限）与检查点回调（`checkpoint`，每次尝试后触发）。
  - 预算耗尽时返回目前最佳可行修复与已证明下界（`lower_bound_changes`、
    `l1_lower_bound`、`cost_lower_bound`），状态为 `feasible` / `budget_exhausted`，
    绝不声称全局最优；只有完整枚举完首个可行层才返回 `optimal`。
- **独立枚举核对** (`mcflow.bruteforce.enumerate_optimal_repair`)：对小网络枚举全部
  整数流，独立计算三级目标最优值，用于交叉验证修复器（见 `tests/test_bruteforce.py`）。

## JSON CLI

```bash
python3.11 -m mcflow verify input.json   # {"network": ..., "certificate": ...}
python3.11 -m mcflow repair input.json   # {"network": ..., "flow": ..., "budget": N?}
```

退出码：0 = 证书合法 / 产出可行修复；1 = 发现违规 / 预算耗尽或不可行；2 = 输入错误。

### 网络格式

```json
{
  "nodes": ["s", "a", "t"],
  "edges": [{"id": "e1", "tail": "s", "head": "a", "lower": 0, "upper": 4, "cost": 1}],
  "demands": {"s": -3, "a": 0, "t": 3}
}
```

`demands[v] > 0` 表示节点 v 需要净流入（inflow − outflow == demand），全部需求之和须为 0。

### 证书格式

```json
{
  "flows": {"e1": 3},
  "potentials": {"s": -2, "a": -1, "t": 0},
  "declared_cost": 6
}
```

## 库用法

```python
from mcflow import Network, verify, repair, verify_cut_certificate

network = Network.from_dict(payload["network"])
report = verify(network, certificate)          # report.ok / report.violations
result = repair(network, flow, budget=100, checkpoint=print)
result.status          # optimal | feasible | budget_exhausted | infeasible
result.optimal         # 仅 status == "optimal" 时为 True
```

## 设计要点

- 验证器与修复器严格分离：`mcflow/verifier.py` 不导入 `repairer`
  （有测试断言），验证只共享最底层残量图工具 `flowsolver`。
- 修复器按修改边数分层枚举候选修改集（k = |forced|, |forced|+1, ...），
  每层用最小费用流精确求解 (L1, 费用) 字典序目标（L1 权重 M 大于任何可能的
  费用差）；层 k 完全不可行才进入 k+1，因此 k 即为修改数的已证明下界。
- 超界/非整数的提交边构成强制修改集，锚点钳制到界内建弧，L1 与修改数仍相对
  原始提交值度量。
- 批量验证共享同一 `Network` 对象时，`verify` 无副作用，前一份非法证书不会
  污染后续结果（有测试覆盖）。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

最近一次运行：26 个测试全部通过（OK）。覆盖：守恒正确但费用非最优、
负费用环、单边超容连锁修复、同修改数不同 L1 的取舍、不可行下界割证书、
篡改势、篡改声明费用、批量验证隔离、预算耗尽的下界报告，以及随机小网络上
修复器与独立全流量枚举的三级目标核对。
