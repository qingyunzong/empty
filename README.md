# csp_dynamic

单机离线、仅依赖 Python 3.11 标准库的动态 CSP 约束求解库及 CLI。

## 功能

- 加载 JSON 描述的二元外延约束（allowed pairs）CSP 问题；
- 初始加载后执行 AC-3 传播，并为每个被剔除值记录剔除理由（依赖的约束 ID 集合）；
- 删除指定约束时做增量松弛：仅在被删除约束所在的连通分量内，对被剔除值候选集求最大不动点并恢复，再触发增量 AC-3 至不动点，不做全量重传播；
- 结果与“从初始域加载剩余全部约束做全量传播”的朴素参考完全一致。

## 输入格式

```json
{
  "variables": [{"name": "x", "domain": [1, 2, 3]}],
  "constraints": [{"id": 0, "scope": ["x", "y"], "relation": [[1, 1], [2, 2]]}]
}
```

`id` 可省略（默认取下标）；`relation` 也可写作 `tuples`。

## CLI

```sh
python -m csp_dynamic delete --input <问题文件> --constraint-id <非负整数>
```

成功输出 `{"status": "ok", "domains": {...}, "restored_values": {...}}`。
错误约定：约束 ID 不存在退出码 3，问题非法退出码 2，均向 stderr 输出
`{"status": "error", ...}`，不修改传播状态。

## 测试

```sh
python -m unittest discover -v
```

测试包含朴素全量重传播参考实现的对照（含随机用例交叉验证）。
