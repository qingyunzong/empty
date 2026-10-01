# billcal — 确定性账单周期展开库

纯 Python 3.11 标准库实现。本地日历递推规则 → 离线时区表 → UTC 区间，
每次调整都输出逐步依据（`steps`），结果完全确定。

## 规则模型（`billcal.model.Rule`）

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `anchor` | `YYYY-MM-DD` | 原始锚定日 |
| `interval_months` | ≥1 | 每 n 月 |
| `day_spec` | `day_of_month` / `last_business_day` | 指定月内日 / 最后一个工作日 |
| `day` | 1..31 | 月内日（默认取 `anchor.day`） |
| `adjust` | `none` / `following` / `preceding` | 业务日顺延 / 逆延 |
| `anchor_mode` | `original` / `adjusted` | 锚定原始日 / 上次调整后日 |
| `holidays`, `weekend` | 日期集合 / 星期几 | 业务日日历 |
| `exceptions_add` / `exceptions_remove` | 本地时刻 / 日期 | 例外增删 |
| `tz` | 表名 | 离线时区表 |
| `gap_policy` | `reject` / `next_valid` | 无解本地时刻：拒绝 / 向前找首个合法时刻 |
| `overlap_policy` | `first` / `second` | 重复本地时刻的显式选择 |
| `version` | 整数 | 规则版本，任何修改必须递增 |

**短月不漂移**：`anchor_mode="original"` 时，1 月 31 日起算的 2 月钳到
28/29 日，3 月回到 31 日；`anchor_mode="adjusted"` 则显式以上次调整后
的日期为下一步基准（漂移是声明的语义，不会悄悄发生）。

## 时区

`billcal.tztable` 使用自包含的转换表（内置 `UTC`、`Asia/Shanghai`、
`America/New_York`，也可用 `load_table_json` 加载自定义表），不读取系统
tzdata。DST 重叠必须显式选 `first`/`second`；DST 空洞按 `gap_policy`
拒绝（计入 `rejected` 并说明原因）或向前扫描首个合法时刻。

## 展开、分页与游标

- `expand(rule, start_utc, end_utc)`：窗口内 UTC 升序、按 UTC 瞬间去重，
  合并的发生保留全部来源（`sources`，如 `["exception_add", "recurrence"]`）。
- `paginate(...)`：正/反向分页。游标包含原锚点、版本与例外集哈希；
  规则变更后旧游标抛出 `StaleCursorError`，绝不混入新版结果。

## CLI

```sh
python3.11 -m billcal tables
python3.11 -m billcal expand --rule examples/rule.json \
    --start 2021-01-01T00:00:00Z --end 2022-01-01T00:00:00Z
python3.11 -m billcal expand --rule examples/rule.json \
    --start 2021-01-01T00:00:00Z --end 2022-01-01T00:00:00Z \
    --limit 5 --direction backward
python3.11 -m billcal verify --rule examples/rule.json \
    --start-year 2019 --end-year 2031
```

所有输出为 JSON；错误以 JSON 写 stderr，退出码 2。

## 独立参考实现

`billcal.reference` 是与引擎独立编写的按日/按月枚举实现，`verify`
命令和 `tests/test_reference.py` 用它在有限年份范围内逐瞬间核对引擎
输出（覆盖 1 月 31 日起算、闰年、跨月连续节假日、DST 重复小时、例外
覆盖递推、逆向分页、规则修改后恢复）。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```
