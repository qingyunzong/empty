# calplan

把一段需求时长（分钟）切成只落在工作日内、避开假期与占用时段的最早连续段。
全部时间为 UTC，所有区间为半开 `[start, end)`，跨午夜按 UTC 日切分。

## 用法

```sh
python -m calplan.cli [input.json]   # 省略路径或传 '-' 时从 stdin 读取
```

输入 JSON 字段：

- `week`：工作日集合， weekday 名（`"Mon"`…`"Sun"`）或整数 0-6（周一为 0）
- `holidays`：假期日期列表，`"YYYY-MM-DD"`，整日禁用（与周末重叠不重复扣）
- `busy`：占用区间列表，`[[start, end], ...]`，ISO 8601 时间戳
- `duration_min`：需求分钟数，非负整数
- `start` / `end`：候选窗口 `[start, end)`，要求 `start < end`

输出（stdout，exit 0）：

```json
{"status": "ok" | "infeasible", "segments": [{"start": "...", "end": "..."}], "remaining_min": 0}
```

容量不足时 `status=infeasible`，`segments` 为已放置的部分，`remaining_min` 为剩余分钟数；
这是正常结果而非错误。输入非法（缺字段、`start >= end`、JSON 解析失败等）时，
stderr 输出 `{"error": {"code": "BAD_INPUT", "message": "..."}}` 并以 exit 2 退出。

## 库接口

```python
from calplan import plan, BadInput
result = plan(payload)  # dict -> dict，非法输入抛出 BadInput
```

## 测试

```sh
python -m unittest discover -s tests -v
```

包含语义单测（周末跳过、假期吞并整天、busy 贴边、不可行、跨午夜切分）、
CLI 错误码测试，以及与分钟级穷举参考算法对照的 200 例随机测试。
