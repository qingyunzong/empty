# timeline

显式 UTC 偏移转换表驱动的时间轴库。Python 3.11 标准库实现，无第三方依赖。

## 三种时间概念（不可混用）

| 类型 | 含义 |
|---|---|
| `Instant` | UTC 时间线上唯一的时间点（epoch 秒） |
| `LocalDateTime` | 本地墙钟读数，不携带偏移；同一墙钟可对应 0/1/2 个时间点 |
| `Duration` | 精确的时间线秒数；86400 秒 ≠ 跨跳变的一个墙钟日 |

## 转换表

`OffsetTable` 是有序、连续、不重叠的转换段（`Segment`）链。每段声明在半开
UTC 区间 `[utc_start, utc_end)` 内生效的偏移秒数；`None` 表示开放端。
偏移可以是任意历史值（如 +08:05:43 = 29143 秒），不要求整小时。

## 映射

- `local_to_instant(table, local)` 返回 0（前跳空洞）、1（正常）或 2
  （后跳折叠）个候选，按时间点排序；每个候选携带来源转换段证据，
  可用 `verify_candidate` 独立校验（`instant + offset == local` 且
  时间点落在段的 UTC 范围内）。
- `instant_to_local(table, instant)` 永远唯一。
- `convert_interval(segments, LocalInterval)` 把本地区间精确拆成 UTC
  区间并集：保留开闭边界，折叠产生的重复区间两个都保留并标记
  `duplicate`（同一来源墙钟子区间），空洞部分在 `gaps` 中报告。

## 两种算术（规则不能互换）

- 墙钟运算：`add_days_wallclock` / `add_months_wallclock`（月末钳位，
  如 1 月 31 日 + 1 月 → 2 月 28/29 日），结果可能落入空洞或折叠。
- 时间线运算：`add_seconds_timeline` / `add_duration`，精确秒数。
- 跨前跳加 1 墙钟日 = 82800 时间线秒，跨后跳 = 90000 秒，均 ≠ 86400。

## 增量修订、快照与缓存

- `table.revise(segments)` 原子地拼接修订段：段间重叠/空洞、或切割
  既有段边界都会整体拒绝，表、版本号、缓存保持不变。
- 修订后版本号 +1，缓存按受影响墙钟范围增量失效（未受影响条目保留）。
- `table.snapshot()` 冻结当前表；历史快照永远按旧表解释，不受后续
  修订影响。
- 表可经 `to_json`/`from_json` 往返序列化；缓存丢失后由表重建，
  结果与崩溃前一致（恢复测试见 `tests/test_revision.py`）。

## JSON CLI

```sh
echo '{"command":"local_to_instant","table":{...},"local":"2024-10-27T01:30:00"}' \
  | python3.11 -m timeline
```

命令：`local_to_instant`、`instant_to_local`、`convert_interval`、
`add_days`、`add_months`、`add_seconds`、`validate_table`、`revise`。
时间点用带 `Z` 的 ISO 字符串（或 epoch 整数），墙钟用朴素 ISO 字符串。
非法修订以退出码 1 和 `{"ok": false, "error": ...}` 原子拒绝。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

测试包含：前跳空洞、后跳折叠、跨午夜转换、连续多次偏移改变、区间端点
落在跳变处、相同墙钟不同候选排序、持续时长往返 ≠ 日历时长、增量修订
与缓存失效、历史快照、原子拒绝、恢复，以及以逐秒枚举短时间轴为独立
对照的交叉验证（`tests/test_bruteforce.py`）。最近一次运行结果见
`TEST_RESULTS.txt`。
