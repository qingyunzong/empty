# csp_dynamic

动态 CSP 约束求解库及配套 CLI，纯 Python 标准库实现（兼容 Python 3.11+），全程单机离线。

## 功能

- 加载 JSON 描述的 CSP（变量 + 表约束），初始执行 AC-3 传播，并为每个被剔除值记录剔除理由（导致剔除的约束 ID 集合）。
- `delete` 操作增量删除约束：仅恢复剔除理由包含被删约束、且无其他生效约束支撑剔除的值（恢复集按最大不动点语义递归计算），随后触发增量 AC-3 至不动点。最终域与从初始域全量加载剩余约束的朴素参考结果完全一致。
- 删除未参与任何剔除的约束时，域状态不变、恢复列表为空。

## 输入格式

```json
{
  "variables": {"x": [1, 2, 3], "y": [1, 2, 3]},
  "constraints": [
    {"id": 0, "scope": ["x", "y"], "type": "allowed", "tuples": [[1, 1], [2, 2]]},
    {"id": 1, "scope": ["y"], "type": "forbidden", "tuples": [[3]]}
  ]
}
```

- `variables`：变量名到初始域的映射（也接受 `[{"name": ..., "domain": [...]}]` 列表形式）。
- `constraints`：`id` 为非负整数（可省略，按位置编号）；`scope` 为约束涉及的变量；`type` 为 `allowed`（默认）或 `forbidden`；`tuples` 长度须与 `scope` 一致。

## CLI

```bash
python -m csp_dynamic delete --input <问题文件> --constraint-id <非负整数>
```

成功时向 stdout 输出 JSON：`status`（`ok` / `unsatisfiable`）、`domains`（传播后各变量域）、`restored_values`（本次删除恢复的值）。
删除不存在的约束 ID 或输入非法时，向 stderr 输出错误 JSON 并返回非零退出码，不修改传播状态。

## 测试

```bash
python -m unittest discover -v
```

测试包含与"全量重传播朴素参考实现"的对照用例及随机化对照测试。
