# calplan

把一个时长需求（分钟）切分成若干**最早**的连续段，使每段都落在 UTC 工作日内，
避开整日假期与半开占用区间。仅使用 Python 3.11 标准库。

## 输入（stdin JSON）

```json
{
  "week": [1, 2, 3, 4, 5],
  "holidays": ["2026-01-01"],
  "busy": [["2026-01-02T10:00:00Z", "2026-01-02T11:00:00Z"]],
  "duration_min": 200,
  "start": "2026-01-01T00:00:00Z",
  "end": "2026-01-05T00:00:00Z"
}
```

- `week`：ISO 工作日集合，1=周一 … 7=周日；必须非空。
- `holidays`：整日禁用的 UTC 日期（`YYYY-MM-DD`）；与周末重叠不重复扣减。
- `busy`：半开占用区间 `[start, end)`，可跨 UTC 午夜，按分钟对齐。
- `duration_min`：非负整数需求时长。
- `start` / `end`：候选窗口 `[start, end)`；时间固定 UTC（`Z` 或 `+00:00`）。

## 输出（stdout JSON）

```json
{
  "status": "feasible",
  "segments": [{"start": "...", "end": "..."}],
  "remaining_minutes": 0
}
```

- 时间一律半开；按 UTC 日切分，段可贴到 `00:00`。
- 从最早的连续空闲段贪心取分钟；并列为确定性结果按 `(start, end)` 排序。
- 窗口内可用分钟不足时 `status` 为 `infeasible`，仍返回已能排入的最早段与剩余分钟。
  infeasible 是正常业务结果（退出码 0），不是解析错误。

## 错误

JSON 缺字段、类型错误、`start >= end`、非 UTC 或非整分钟时间均为 `BAD_INPUT`：
错误 JSON 写到 **stderr**，退出码为 **2**。

## 用法

```bash
python -m calplan.cli < request.json
python -m unittest discover -s tests -v
```
