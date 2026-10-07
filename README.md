# scheddiag

有限时间预算下的排期诊断：整数差分约束 + 互斥时间区间的组合求解器，
严格区分 `sat` / `unsat` / `unknown`。仅使用 Python 3.11 标准库。

## 模型

- 每个任务 `i` 有开始时间变量 `x_i`（整数）和正整数时长 `d_i`；另有一个
  参考变量 `zero`（值恒为 0，实例中可用下标 `num_tasks` 或字符串 `"zero"` 引用）。
- 差分约束：`x_v - x_u <= w`（`u`、`v`、`w` 均为整数）。
- 互斥约束（disjunct）：任务 `a`、`b` 的区间 `[x_a, x_a+d_a)` 与
  `[x_b, x_b+d_b)` 不得重叠，通过分支选择先后顺序（`a` 先或 `b` 先）。

## 求解器（`scheddiag.solver.Solver`）

- 差分部分用势函数（Bellman-Ford 轮次）维护，负环提取为冲突证书；
- 互斥关系通过分支选择先后顺序，叶冲突汇总为可独立重放的分支冲突树；
- 增量 `add_constraint` / `add_disjunct`，嵌套 `push()` / `pop()`；
  撤销基于 trail：恢复该约束造成的势收紧，并按依赖清除相关冲突，
  不只是删除边；
- 预算分别按松弛步数（`slack_budget`）与分支节点数（`branch_budget`）计；
  耗尽返回 `unknown`、当前可行候选（仅满足已决定约束，不推断全局可行）
  以及可保存/恢复的搜索前沿（`frontier` token，可跨实例、跨进程恢复）。

## 证据检查器（`scheddiag.checker`）

不复用求解器的任何传播/剪枝逻辑，直接从实例重放：

- `sat`：完整整数时间表，逐条核对差分约束与互斥区间；
- `unsat`：分支冲突树，沿每条根到叶路径重建边集，验证叶负环
  （结构为简单有向环、权和为负、与声明权重一致、只引用路径上已决定的
  分支边），并验证分支树完整（每个分支节点恰两个互补子分支、同一
  disjunct 不在一条路径上重复分支）；
- `unknown`：候选时间表仅对照静态约束与已决定顺序核对。

## 有界枚举核对（`scheddiag.brute`）

对小实例在有界整数时间窗内枚举全部开始时间赋值，直接核对求解器结论
（窗口界由 Bellman-Ford 势的范围保证完备）。

## JSON CLI

```bash
python3.11 -m scheddiag request.json        # 或从 stdin 读取
```

求解请求：

```json
{
  "command": "solve",
  "instance": {
    "num_tasks": 2,
    "durations": [3, 3],
    "constraints": [{"u": "zero", "v": 0, "w": 1}, {"u": 0, "v": "zero", "w": 0}],
    "disjuncts": [[0, 1]]
  },
  "budget": {"slack": 1000, "branches": 100}
}
```

- `sat` 输出含 `schedule` 与 `certificate`；
- `unsat` 输出含分支冲突树 `certificate.tree`（叶为负环）；
- `unknown` 输出含 `candidate`、`frontier`（可作为下次请求的
  `"frontier"` 恢复搜索）与 `reason`；
- `{"command": "check", "instance": ..., "evidence": ...}` 独立验证证据，
  返回 `{"valid": bool, "reason": str}`；
- 输入错误返回 `{"status": "error", ...}`，退出码 2，求解器状态不变。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：差分局部可行但互斥组合无解、撤销后重新可行、同一分支反复暂停
恢复、预算恰在冲突前结束、无效证书、输入错误回滚，以及随机小实例与
有界枚举的交叉核对。
