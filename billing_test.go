package billing

import (
	"errors"
	"math/big"
	"testing"
	"time"
)

var base = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(hours, minutes int) time.Time {
	return base.Add(time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute)
}

func ratString(r *big.Rat) string { return r.RatString() }

// 基本计费：有理单价 × 整数用量 × 小时，输出精确分数明细。
func TestBillExactFractionalLineItems(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(3, 0), big.NewRat(1, 3))) // 1/3 元每单位每小时
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(2, 0), 2))

	inv, err := Bill(book, curve, at(0, 0), at(3, 0))
	if err != nil {
		t.Fatalf("Bill 失败: %v", err)
	}
	if len(inv.Items) != 1 {
		t.Fatalf("明细条数 = %d, 期望 1", len(inv.Items))
	}
	it := inv.Items[0]
	if got := ratString(it.UnitPrice); got != "1/3" {
		t.Errorf("单价 = %s, 期望 1/3", got)
	}
	if got := ratString(it.Hours); got != "2" {
		t.Errorf("小时数 = %s, 期望 2", got)
	}
	if got := ratString(it.Amount); got != "4/3" {
		t.Errorf("金额 = %s, 期望 4/3", got)
	}
	if got := ratString(inv.Total); got != "4/3" {
		t.Errorf("合计 = %s, 期望 4/3", got)
	}
	// 4/3 元 = 133.33... 分 → 133 分
	if got := inv.TotalCents(); got != 133 {
		t.Errorf("合计分 = %d, 期望 133", got)
	}
}

// 半开区间：相邻分段在边界处不重复、不遗漏计费。
func TestHalfOpenBoundariesNoDoubleCount(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(1, 0), big.NewRat(10, 1)))
	must(t, book.SetPrice(at(1, 0), at(2, 0), big.NewRat(20, 1)))
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(2, 0), 1))

	inv, err := Bill(book, curve, at(0, 0), at(2, 0))
	if err != nil {
		t.Fatalf("Bill 失败: %v", err)
	}
	if len(inv.Items) != 2 {
		t.Fatalf("明细条数 = %d, 期望 2", len(inv.Items))
	}
	// 第一段 [0,1) 按 10 元计 1 小时，第二段 [1,2) 按 20 元计 1 小时。
	if got := ratString(inv.Items[0].Amount); got != "10" {
		t.Errorf("第一段金额 = %s, 期望 10", got)
	}
	if got := ratString(inv.Items[1].Amount); got != "20" {
		t.Errorf("第二段金额 = %s, 期望 20", got)
	}
	if got := ratString(inv.Total); got != "30" {
		t.Errorf("合计 = %s, 期望 30", got)
	}
	if !inv.Items[0].End.Equal(inv.Items[1].Start) {
		t.Errorf("明细区间未在边界衔接: %s vs %s", inv.Items[0].End, inv.Items[1].Start)
	}
}

// 缺价格时整次失败，并报告全部未定价区间。
func TestMissingPriceFailsWholeRun(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(1, 0), at(2, 0), big.NewRat(5, 1)))
	must(t, book.SetPrice(at(4, 0), at(5, 0), big.NewRat(5, 1)))
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(6, 0), 1))

	inv, err := Bill(book, curve, at(0, 0), at(6, 0))
	if err == nil {
		t.Fatalf("期望未定价错误, 得到账单 %+v", inv)
	}
	var upe *UnpricedError
	if !errors.As(err, &upe) {
		t.Fatalf("错误类型 = %T, 期望 *UnpricedError", err)
	}
	want := []Interval{
		{at(0, 0), at(1, 0)},
		{at(2, 0), at(4, 0)},
		{at(5, 0), at(6, 0)},
	}
	if len(upe.Unpriced) != len(want) {
		t.Fatalf("未定价区间数 = %d, 期望 %d (%v)", len(upe.Unpriced), len(want), upe.Unpriced)
	}
	for i, iv := range want {
		if !upe.Unpriced[i].Start.Equal(iv.Start) || !upe.Unpriced[i].End.Equal(iv.End) {
			t.Errorf("未定价区间[%d] = [%s, %s), 期望 [%s, %s)",
				i, upe.Unpriced[i].Start, upe.Unpriced[i].End, iv.Start, iv.End)
		}
	}
}

// 零用量区间不要求价格覆盖。
func TestZeroUsageNeedsNoPrice(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(1, 0), big.NewRat(7, 1)))
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(1, 0), 3))
	must(t, curve.SetUsage(at(1, 0), at(2, 0), 0)) // 无价格但零用量

	inv, err := Bill(book, curve, at(0, 0), at(2, 0))
	if err != nil {
		t.Fatalf("Bill 失败: %v", err)
	}
	if got := ratString(inv.Total); got != "21" {
		t.Errorf("合计 = %s, 期望 21", got)
	}
}

// 追溯改价：覆盖历史区间后重算，结果随之更新，且审计日志完整。
func TestRetroactiveRepricing(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(2, 0), big.NewRat(10, 1)))
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(2, 0), 1))

	inv1, err := Bill(book, curve, at(0, 0), at(2, 0))
	if err != nil {
		t.Fatalf("首次计费失败: %v", err)
	}
	if got := ratString(inv1.Total); got != "20" {
		t.Fatalf("改价前合计 = %s, 期望 20", got)
	}

	// 追溯把 [0,1) 改为 50 元。
	must(t, book.SetPrice(at(0, 0), at(1, 0), big.NewRat(50, 1)))
	inv2, err := Bill(book, curve, at(0, 0), at(2, 0))
	if err != nil {
		t.Fatalf("改价后计费失败: %v", err)
	}
	if got := ratString(inv2.Total); got != "60" {
		t.Errorf("改价后合计 = %s, 期望 60", got)
	}

	// 价目表被切分为两段且互不重叠。
	segs := book.Segments()
	if len(segs) != 2 {
		t.Fatalf("分段数 = %d, 期望 2", len(segs))
	}
	if ratString(segs[0].Price) != "50" || ratString(segs[1].Price) != "10" {
		t.Errorf("分段价格 = %s, %s; 期望 50, 10", segs[0].Price, segs[1].Price)
	}
	if !segs[0].End.Equal(segs[1].Start) {
		t.Errorf("分段未衔接: %s vs %s", segs[0].End, segs[1].Start)
	}

	// 审计日志记录两次改价。
	changes := book.Changes()
	if len(changes) != 2 {
		t.Fatalf("改价记录数 = %d, 期望 2", len(changes))
	}
	if changes[1].Seq != 2 || ratString(changes[1].Price) != "50" {
		t.Errorf("第二条改价记录 = %+v, 期望 Seq=2 Price=50", changes[1])
	}
}

// 逐单位小时间域核验：非整小时按精确分数小时计费，单价×单位×小时逐步可核。
func TestPerUnitHourTimeDomain(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(2, 0), big.NewRat(1, 7))) // 1/7 元每单位每小时
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(0, 20), 3))  // 20 分钟 = 1/3 小时
	must(t, curve.SetUsage(at(0, 20), at(1, 30), 2)) // 70 分钟 = 7/6 小时

	inv, err := Bill(book, curve, at(0, 0), at(2, 0))
	if err != nil {
		t.Fatalf("Bill 失败: %v", err)
	}
	if len(inv.Items) != 2 {
		t.Fatalf("明细条数 = %d, 期望 2", len(inv.Items))
	}
	// 第一段: 1/7 × 3 × 1/3 = 1/7
	if got := ratString(inv.Items[0].Hours); got != "1/3" {
		t.Errorf("第一段小时 = %s, 期望 1/3", got)
	}
	if got := ratString(inv.Items[0].Amount); got != "1/7" {
		t.Errorf("第一段金额 = %s, 期望 1/7", got)
	}
	// 第二段: 1/7 × 2 × 7/6 = 1/3
	if got := ratString(inv.Items[1].Hours); got != "7/6" {
		t.Errorf("第二段小时 = %s, 期望 7/6", got)
	}
	if got := ratString(inv.Items[1].Amount); got != "1/3" {
		t.Errorf("第二段金额 = %s, 期望 1/3", got)
	}
	// 合计: 1/7 + 1/3 = 10/21
	if got := ratString(inv.Total); got != "10/21" {
		t.Errorf("合计 = %s, 期望 10/21", got)
	}
}

// 用量曲线越出计费窗口时，仅窗口内部分计费。
func TestWindowClipsUsage(t *testing.T) {
	book := NewPriceBook()
	must(t, book.SetPrice(at(0, 0), at(4, 0), big.NewRat(6, 1)))
	curve := NewUsageCurve()
	must(t, curve.SetUsage(at(0, 0), at(4, 0), 1))

	inv, err := Bill(book, curve, at(1, 0), at(3, 0))
	if err != nil {
		t.Fatalf("Bill 失败: %v", err)
	}
	if got := ratString(inv.Total); got != "12" {
		t.Errorf("合计 = %s, 期望 12", got)
	}
	if !inv.Items[0].Start.Equal(at(1, 0)) || !inv.Items[0].End.Equal(at(3, 0)) {
		t.Errorf("明细区间 = [%s, %s), 期望 [1h, 3h)", inv.Items[0].Start, inv.Items[0].End)
	}
}

// 非法输入校验。
func TestInvalidInputs(t *testing.T) {
	book := NewPriceBook()
	if err := book.SetPrice(at(1, 0), at(0, 0), big.NewRat(1, 1)); err == nil {
		t.Error("空价格区间应报错")
	}
	if err := book.SetPrice(at(0, 0), at(1, 0), big.NewRat(-1, 1)); err == nil {
		t.Error("负价格应报错")
	}
	if err := book.SetPrice(at(0, 0), at(1, 0), nil); err == nil {
		t.Error("nil 价格应报错")
	}
	curve := NewUsageCurve()
	if err := curve.SetUsage(at(0, 0), at(1, 0), -1); err == nil {
		t.Error("负用量应报错")
	}
	if _, err := Bill(book, curve, at(1, 0), at(0, 0)); err == nil {
		t.Error("空计费窗口应报错")
	}
	if _, err := Bill(nil, curve, at(0, 0), at(1, 0)); err == nil {
		t.Error("nil 价目表应报错")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
}
