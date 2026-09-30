# csp_restart

单机离线的约束求解库与 CLI：在带回溯 + 前向检查传播的 CSP 求解器之上，
实现累计冲突触发的重启机制与全局合法 Nogood 学习，严格区分未决
（`timeout`）与不可满足（`unsat`）状态。仅使用 Python 标准库（3.11+）。

## CLI 用法

```
python -m csp_restart run --input <问题文件> --restart-threshold <非负整数> --total-budget <非负整数>
```

输出为 JSON，包含 `status`、`solution`、`nogoods`、`restart_count` 四个字段。
`status` 取值：`sat` / `unsat` / `timeout`。

错误约定：阈值或预算为负、输入文件缺失、JSON 非法、问题描述非法时，
进程以非零错误码退出（参数错误为 2，输入问题非法为 1）。

## 问题 JSON 格式

```json
{
  "variables": [{"name": "x", "domain": [1, 2]}],
  "constraints": [
    {"type": "eq", "vars": ["x", "y"]},
    {"type": "neq", "vars": ["x", "y"]},
    {"type": "all_different", "vars": ["x", "y", "z"]},
    {"type": "table", "vars": ["x", "z"], "allowed": [[1, 1], [2, 2]]},
    {"type": "linear", "vars": ["x", "y"], "coeffs": [1, 1], "op": "<=", "value": 3}
  ]
}
```

## 语义

1. 搜索中每次域空（传播失败）计为 1 次冲突；自上次重启以来累计冲突
   达到重启阈值时立即触发重启。
2. 重启仅保留所有已生成的全局合法 Nogood，撤销全部非 0 层决策、恢复
   初始域、决策计数清零，不保留任何临时传播状态。
3. 总冲突预算耗尽时立即终止，状态为 `timeout`（未决）；只有推导出
   0 层矛盾时才返回 `unsat`。
4. 0 层传播直接冲突时不触发重启，直接返回 `unsat`。

## 测试

```
python -m unittest discover -v
```

测试包含与无重启朴素回溯参考实现（`csp_restart.naive_solve`）的对照用例。
真实测试结果见 `result.txt`。
