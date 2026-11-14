# 日历周期区间生成

报表管线需要可直接接入 Go 日历区间库，按时区生成自然日、ISO 周、财务月和4-4-5周期的半开 instant 区间。DST 日可非24小时，闰周由配置年份规则决定；相邻区间无缝且覆盖查询范围，任意切分后合并结果一致。

## 用法

```go
loc, _ := time.LoadLocation("America/New_York")

day := dataeng.NewDayCalendar(loc)                 // 自然日（DST 日 23h/25h）
week := dataeng.NewISOWeekCalendar(loc)            // ISO 8601 周（周一起）
fiscal := dataeng.NewFiscalMonthCalendar(loc, time.July) // 财务月（7 月起财年）
retail := dataeng.NewRetail445Calendar(loc, time.Sunday, time.February, 1, dataeng.Nearest) // NRF 4-4-5

ivs := day.Intervals(from, to) // 半开 [Start, End)，首尾裁剪到查询范围，相邻无缝
```

- 所有日历实现 `Calendar` 接口：`Intervals` / `IsBoundary` / `Label`。
- 4-4-5 闰周默认由锚点规则（如"2 月 1 日最近的周日"）自动推出 52/53 周年，也可用 `Retail445Calendar.LeapYears` 显式指定 53 周年；闰周附加在年末最后一个周期。
- 区间边界只取决于日历配置与 instant，与查询范围无关：任意切分查询范围后分段生成，再用 `MergeSplit(cal, parts)` 合并，结果与整段生成完全一致。`MergeAdjacent` 可将相邻区间合并为连续跨度，`Merge` 可合并无序/重叠输入。

运行测试：`go test ./...`
