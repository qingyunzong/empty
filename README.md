# billcycle — 本地日历账单周期展开库

纯 Python 3.11 标准库实现（无第三方依赖），把"每 n 月某日出账"这类
本地日历递推规则展开为确定性的 UTC 时刻序列，并对每一次调整给出
逐步依据。

## 能力一览

- **递推规则**：每 `interval_months` 月；月内日支持 `1..31`、
  `last`（月末）、`last_business_day`（最后一个工作日）。
- **锚定语义（显式）**：
  - `anchor_mode=original`：每个周期由原始锚点推算，短月钳制只影响
    当期（1 月 31 日起算，2 月落到 28/29 日，3 月回到 31 日，
    **绝不悄悄漂移**）；
  - `anchor_mode=rolling`：每个周期从上次**调整后**的日期推算，
    可能漂移——必须显式选择，且每一步都记录在案。
- **业务日调整**：`following`（顺延）/ `preceding`（逆延）/ `none`，
  逐日跳过周末与节假日，跨月连续节假日会逐日记录依据。
- **例外增删**：`remove_dates` 按周期原始候选日删除；`add_dates`
  按原样加入。同一时刻由多个来源产生时**去重并保留全部来源**。
- **离线时区表**：内置 `UTC`、`Asia/Shanghai`、`America/New_York`、
  `Europe/London`，由转换规则算法生成，不依赖系统 tzdata。
  - 重复本地时刻（秋令时回拨）：`repeat_policy` 必须显式选择
    `earlier` / `later` / `reject`；
  - 无解本地时刻（春令时跳空）：`gap_policy` 为 `reject` 或
    `shift_forward`（向前寻找首个合法时刻）。
- **增量变更与分页**：规则修改通过 `rule.updated(...)` 使版本号 +1；
  分页游标内含**原始锚点、规则版本、例外集哈希**及展开区间，
  旧游标与新版规则混用时抛出 `CursorMismatch`，绝不混入旧结果。
  支持正向与逆向分页。
- **独立核对**：`billcycle.reference` 是与主引擎零共享逻辑的
  逐日枚举参考实现，可对有限年份区间交叉核对。

## 快速开始

```bash
# 展开（JSON 进，JSON 出）
python3.11 -m billcycle expand \
    --rule examples/rule.json --holidays examples/holidays.json \
    --start 2024-01-01T00:00:00Z --end 2026-01-01T00:00:00Z

# 分页（游标来自上一页的 next_cursor）
python3.11 -m billcycle expand --rule examples/rule.json \
    --start 2024-01-01T00:00:00Z --end 2026-01-01T00:00:00Z \
    --page-size 5 --reverse

# 主引擎 vs 参考实现交叉核对
python3.11 -m billcycle verify --rule examples/rule.json \
    --holidays examples/holidays.json \
    --start-date 2024-01-01 --end-date 2026-12-31

# 测试
python3.11 -m unittest discover -s tests -v
```

## 规则 JSON

```json
{
  "name": "monthly-billing",
  "anchor": "2024-01-31",
  "interval_months": 1,
  "day_of_month": 31,
  "anchor_mode": "original",
  "adjust": "following",
  "time_of_day": "09:30",
  "zone": "America/New_York",
  "gap_policy": "shift_forward",
  "repeat_policy": "earlier",
  "add_dates": ["2024-03-15"],
  "remove_dates": ["2024-05-31"],
  "version": 1
}
```

节假日日历 JSON：`{"holidays": {"2025-01-01": "New Year"}, "weekend": [5, 6]}`。

## 输出

每次展开返回 `occurrences`（按 UTC 排序去重，含 `sources` 与逐条
`steps` 依据）、`rejected`（被时区策略拒绝的时刻及原因）、
`removed`（被例外删除的周期）以及 `next_cursor` / `has_more`。
所有结果确定性可复现：同一输入必然得到逐字节相同的输出。

## 代码结构

- `billcycle/tztable.py` — 离线时区转换表与本地时刻解析策略
- `billcycle/calendar.py` — 业务日历（周末 + 节假日，顺/逆延）
- `billcycle/rule.py` — 规则定义、校验、版本与例外集哈希、JSON 编解码
- `billcycle/engine.py` — 展开引擎、UTC 排序去重、游标分页
- `billcycle/reference.py` — 独立逐日枚举参考实现与交叉核对
- `billcycle/cli.py` — JSON 命令行（`expand` / `verify`）
- `tests/` — unittest 套件（59 项）
