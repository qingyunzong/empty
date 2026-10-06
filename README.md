# dateparse

一个只依赖 Go 标准库的日期解析库：调用方提供格式集合，库在输入文本中查找匹配，
并按显式公历规则校验，绝不自行猜测缺失或歧义的字段。

## 设计规则

- **用户提供格式集合**：`Parse(input, formats)` 接受多个 Go 参考时间风格的布局，
  支持的 token 为 `2006 06 01 1 Jan January 02 2 _2 15 03 3 04 4 05 5 PM pm`
  及 `-07:00 -0700 -07 Z07:00 Z0700 Z07`，其余字节按字面量匹配。
- **显式公历规则**：闰年判定为「能被 4 整除，但世纪年须能被 400 整除」，
  每月天数按该规则显式校验（如 2023-02-29、2025-04-31 均拒绝），不依赖归一化。
- **不猜月日**：格式必须包含年、月、日 token，否则返回 `FormatError`；
  多个格式匹配出不同日期时返回 `AmbiguityError`（列出全部候选格式、日期与区间），
  只有所有匹配格式得到同一日期时才返回结果。
- **闰秒拒绝**：秒字段为 60 时返回 `LeapSecondError`；61 及以上按越界处理（`NoMatchError`）。
- **时区偏移为整数分钟**：结果中 `Date.OffsetMinutes` 为 UTC 以东的分钟数
  （如 `+08:00` → 480，`-05:30` → -330，`Z` → 0），并校验小时 ≤ 23、分钟 ≤ 59。
- **输出匹配格式与原区间**：`Result.Format`/`Result.Formats` 给出匹配的格式，
  `Result.Start`/`Result.End` 给出匹配文本在输入中的字节区间，
  `Result.Text(input)` 直接返回匹配子串。

## 示例

```go
r, err := dateparse.Parse("Event: 2025-03-04 (confirmed)", []string{"2006-01-02"})
// r.Date  = 2025-03-04
// r.Start = 7, r.End = 17, r.Text(input) = "2025-03-04"

_, err = dateparse.Parse("03/04/2025", []string{"01/02/2006", "02/01/2006"})
// err 为 *AmbiguityError：2025-03-04 与 2025-04-03 两个候选，不猜测

_, err = dateparse.Parse("2016-12-31 23:59:60", []string{"2006-01-02 15:04:05"})
// err 为 *LeapSecondError
```

## 测试

`parse_test.go` 中的 `TestExhaustiveBoundaryYears` 对 0–9999 全部年份逐月穷举核对：
闰年规则与标准库 `time.Date` 归一化行为交叉验证、2 月 29 日恰好只在闰年可解析、
每月最后一天可解析而后一天不可解析、月天数与标准库一致。

实际运行结果（Go 1.27.1，linux/amd64）：

```
$ go test ./...
ok  	dateparse	1.640s
```

全部 21 个测试通过（含穷举边界年份核对，单项耗时约 1.37s）。
