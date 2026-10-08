// Package billing 实现分段计费：分段有理单价（每单位每小时）乘以整数用量曲线，
// 价格与用量均为半开区间 [Start, End)。金额全程使用精确有理数运算，
// 仅在最终合计时按“分”做最近偶数舍入（round-half-to-even）。
package billing

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"
)

// nanosPerHour 是一小时的纳秒数，用于把时间段精确换算为有理数小时。
const nanosPerHour = int64(time.Hour)

// Interval 表示半开区间 [Start, End)。
type Interval struct {
	Start time.Time
	End   time.Time
}

// Hours 返回区间长度的精确有理数小时数。
func (iv Interval) Hours() *big.Rat {
	return durationHours(iv.End.Sub(iv.Start))
}

func durationHours(d time.Duration) *big.Rat {
	return big.NewRat(int64(d), nanosPerHour)
}

func (iv Interval) valid() bool { return iv.Start.Before(iv.End) }

// overlaps 判断两个半开区间是否相交。
func overlaps(a, b Interval) bool {
	return a.Start.Before(b.End) && b.Start.Before(a.End)
}

// intersect 返回两个半开区间的交集；ok 为 false 表示不相交。
func intersect(a, b Interval) (Interval, bool) {
	iv := Interval{Start: maxTime(a.Start, b.Start), End: minTime(a.End, b.End)}
	return iv, iv.Start.Before(iv.End)
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// PriceSegment 是一段半开区间上的单价，单位为 货币/(单位·小时)，精确有理数。
type PriceSegment struct {
	Interval
	Price *big.Rat
}

// PriceChange 记录一次改价（含追溯改价），用于审计。
type PriceChange struct {
	Seq int
	Interval
	Price *big.Rat
}

// PriceBook 保存互不重叠、按时间排序的分段单价，支持追溯改价。
type PriceBook struct {
	segments []PriceSegment
	changes  []PriceChange
}

// NewPriceBook 创建空价目表。
func NewPriceBook() *PriceBook { return &PriceBook{} }

// SetPrice 将 [start, end) 的单价设为 price（每单位每小时）。
// 与既有分段重叠的部分被覆盖，既有分段按需切分；可用于追溯修改历史价格。
// price 必须非负。
func (b *PriceBook) SetPrice(start, end time.Time, price *big.Rat) error {
	iv := Interval{Start: start, End: end}
	if !iv.valid() {
		return fmt.Errorf("billing: 非法价格区间 [%s, %s)", start, end)
	}
	if price == nil {
		return fmt.Errorf("billing: 价格不能为 nil")
	}
	if price.Sign() < 0 {
		return fmt.Errorf("billing: 价格不能为负: %s", price.RatString())
	}
	p := new(big.Rat).Set(price)
	next := make([]PriceSegment, 0, len(b.segments)+2)
	for _, s := range b.segments {
		if !overlaps(s.Interval, iv) {
			next = append(next, s)
			continue
		}
		if s.Start.Before(start) {
			next = append(next, PriceSegment{Interval{Start: s.Start, End: start}, s.Price})
		}
		if s.End.After(end) {
			next = append(next, PriceSegment{Interval{Start: end, End: s.End}, s.Price})
		}
	}
	next = append(next, PriceSegment{iv, p})
	sort.Slice(next, func(i, j int) bool { return next[i].Start.Before(next[j].Start) })
	b.segments = mergeAdjacentPrice(next)
	b.changes = append(b.changes, PriceChange{Seq: len(b.changes) + 1, Interval: iv, Price: p})
	return nil
}

// mergeAdjacentPrice 合并相邻且等价的半开分段，保持规范化。
func mergeAdjacentPrice(in []PriceSegment) []PriceSegment {
	out := in[:0]
	for _, s := range in {
		if n := len(out); n > 0 && out[n-1].End.Equal(s.Start) && out[n-1].Price.Cmp(s.Price) == 0 {
			out[n-1].End = s.End
			continue
		}
		out = append(out, s)
	}
	return out
}

// Segments 返回当前生效的价格分段副本（按时间升序、互不重叠）。
func (b *PriceBook) Segments() []PriceSegment {
	out := make([]PriceSegment, len(b.segments))
	copy(out, b.segments)
	return out
}

// Changes 返回改价审计日志（含追溯改价），按发生顺序排列。
func (b *PriceBook) Changes() []PriceChange {
	out := make([]PriceChange, len(b.changes))
	copy(out, b.changes)
	return out
}

// UsageSegment 是一段半开区间上的整数用量（单位数）。
type UsageSegment struct {
	Interval
	Units int64
}

// UsageCurve 保存互不重叠、按时间排序的整数用量分段。
type UsageCurve struct {
	segments []UsageSegment
}

// NewUsageCurve 创建空用量曲线。
func NewUsageCurve() *UsageCurve { return &UsageCurve{} }

// SetUsage 将 [start, end) 的用量设为 units（必须非负整数）。
// 与既有分段重叠的部分被覆盖，既有分段按需切分。
func (c *UsageCurve) SetUsage(start, end time.Time, units int64) error {
	iv := Interval{Start: start, End: end}
	if !iv.valid() {
		return fmt.Errorf("billing: 非法用量区间 [%s, %s)", start, end)
	}
	if units < 0 {
		return fmt.Errorf("billing: 用量不能为负: %d", units)
	}
	next := make([]UsageSegment, 0, len(c.segments)+2)
	for _, s := range c.segments {
		if !overlaps(s.Interval, iv) {
			next = append(next, s)
			continue
		}
		if s.Start.Before(start) {
			next = append(next, UsageSegment{Interval{Start: s.Start, End: start}, s.Units})
		}
		if s.End.After(end) {
			next = append(next, UsageSegment{Interval{Start: end, End: s.End}, s.Units})
		}
	}
	next = append(next, UsageSegment{iv, units})
	sort.Slice(next, func(i, j int) bool { return next[i].Start.Before(next[j].Start) })
	c.segments = mergeAdjacentUsage(next)
	return nil
}

func mergeAdjacentUsage(in []UsageSegment) []UsageSegment {
	out := in[:0]
	for _, s := range in {
		if n := len(out); n > 0 && out[n-1].End.Equal(s.Start) && out[n-1].Units == s.Units {
			out[n-1].End = s.End
			continue
		}
		out = append(out, s)
	}
	return out
}

// Segments 返回用量分段副本（按时间升序、互不重叠）。
func (c *UsageCurve) Segments() []UsageSegment {
	out := make([]UsageSegment, len(c.segments))
	copy(out, c.segments)
	return out
}

// LineItem 是一条精确的计费明细：单价 × 单位数 × 小时数，全部为精确有理数。
type LineItem struct {
	Interval
	Units     int64
	UnitPrice *big.Rat // 每单位每小时
	Hours     *big.Rat // 区间长度（小时）
	Amount    *big.Rat // UnitPrice * Units * Hours，精确分数
}

// UnpricedError 表示计费窗口内存在未定价区间；整次计费失败并报告全部缺口。
type UnpricedError struct {
	Window   Interval
	Unpriced []Interval
}

func (e *UnpricedError) Error() string {
	parts := make([]string, len(e.Unpriced))
	for i, iv := range e.Unpriced {
		parts[i] = fmt.Sprintf("[%s, %s)", iv.Start.Format(time.RFC3339), iv.End.Format(time.RFC3339))
	}
	return fmt.Sprintf("billing: 窗口 [%s, %s) 内存在未定价区间: %s",
		e.Window.Start.Format(time.RFC3339), e.Window.End.Format(time.RFC3339), strings.Join(parts, ", "))
}

// Invoice 是一次计费的结果：精确分数明细与精确合计。
type Invoice struct {
	Window Interval
	Items  []LineItem
	Total  *big.Rat // 精确合计（未舍入）
}

// TotalCents 将精确合计按“分”做最近偶数舍入，返回整数分。
func (inv *Invoice) TotalCents() int64 {
	return ToCentsHalfEven(inv.Total)
}

// Bill 对窗口 [from, to) 执行一次计费。
//
// 窗口内所有用量大于零的区间都必须被价格覆盖；只要存在未定价区间，
// 整次计费失败并返回 *UnpricedError（其中列出全部未定价区间），不产生部分账单。
// 成功时返回精确分数明细（每段 单价×单位×小时）与精确合计。
func Bill(book *PriceBook, curve *UsageCurve, from, to time.Time) (*Invoice, error) {
	window := Interval{Start: from, End: to}
	if !window.valid() {
		return nil, fmt.Errorf("billing: 非法计费窗口 [%s, %s)", from, to)
	}
	if book == nil || curve == nil {
		return nil, fmt.Errorf("billing: 价目表与用量曲线不能为 nil")
	}

	var items []LineItem
	var gaps []Interval
	total := new(big.Rat)

	for _, u := range curve.segments {
		if u.Units == 0 {
			continue // 零用量不产生金额，也不要求价格覆盖
		}
		uiv, ok := intersect(u.Interval, window)
		if !ok {
			continue
		}
		// 沿价格分段切分用量区间，收集明细或缺口。
		cursor := uiv.Start
		for _, p := range book.segments {
			if !p.End.After(cursor) {
				continue
			}
			if !p.Start.Before(uiv.End) {
				break
			}
			if p.Start.After(cursor) {
				gaps = append(gaps, Interval{Start: cursor, End: minTime(p.Start, uiv.End)})
			}
			piece, ok := intersect(uiv, p.Interval)
			if !ok {
				continue
			}
			hours := piece.Hours()
			amount := new(big.Rat).Mul(p.Price, hours)
			amount.Mul(amount, new(big.Rat).SetInt64(u.Units))
			items = append(items, LineItem{
				Interval:  piece,
				Units:     u.Units,
				UnitPrice: new(big.Rat).Set(p.Price),
				Hours:     hours,
				Amount:    amount,
			})
			total.Add(total, amount)
			cursor = maxTime(cursor, piece.End)
		}
		if cursor.Before(uiv.End) {
			gaps = append(gaps, Interval{Start: cursor, End: uiv.End})
		}
	}

	if len(gaps) > 0 {
		return nil, &UnpricedError{Window: window, Unpriced: mergeAdjacentIntervals(gaps)}
	}
	return &Invoice{Window: window, Items: items, Total: total}, nil
}

// mergeAdjacentIntervals 合并相邻或重叠的区间（缺口上报前规范化）。
func mergeAdjacentIntervals(in []Interval) []Interval {
	if len(in) == 0 {
		return nil
	}
	sorted := make([]Interval, len(in))
	copy(sorted, in)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start.Before(sorted[j].Start) })
	out := sorted[:0]
	for _, iv := range sorted {
		if n := len(out); n > 0 && !out[n-1].End.Before(iv.Start) {
			out[n-1].End = maxTime(out[n-1].End, iv.End)
			continue
		}
		out = append(out, iv)
	}
	return out
}
