package settle

import (
	"math/big"
	"testing"
)

// ---------- 独立任意精度分数模型（基于 math/big.Rat，与被测 Frac 实现无关） ----------

func ratModel(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad test rat %q", s)
	}
	return r
}

// modelHalfEven 是独立的半偶舍入模型：输入精确有理数与小数位，返回最小单位整数。
func modelHalfEven(t *testing.T, v *big.Rat, scale int) *big.Int {
	t.Helper()
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	scaled := new(big.Rat).Mul(v, new(big.Rat).SetInt(pow))
	num, den := scaled.Num(), scaled.Denom()
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	absR2 := new(big.Int).Lsh(new(big.Int).Abs(r), 1)
	switch absR2.Cmp(den) {
	case 1:
		q.Add(q, big.NewInt(int64(scaled.Sign())))
	case 0:
		if new(big.Int).Abs(q).Bit(0) == 1 {
			q.Add(q, big.NewInt(int64(scaled.Sign())))
		}
	}
	return q
}

// modelNet 独立复算优惠后金额：先百分比后固定减免。
func modelNet(qty, price, pctOff, amtOff *big.Rat) *big.Rat {
	gross := new(big.Rat).Mul(qty, price)
	if pctOff != nil {
		gross.Mul(gross, new(big.Rat).Sub(big.NewRat(1, 1), pctOff))
	}
	if amtOff != nil {
		gross.Sub(gross, amtOff)
	}
	return gross
}

func fracMustRat(t *testing.T, f Frac, want *big.Rat, ctx string) {
	t.Helper()
	got := new(big.Rat).SetFrac(f.Num(), f.Den())
	if got.Cmp(want) != 0 {
		t.Fatalf("%s: got %s, model wants %s", ctx, got.RatString(), want.RatString())
	}
}

// ---------- Frac 四则运算对照 ----------

func TestFracArithmeticVsRatModel(t *testing.T) {
	cases := []struct{ a, b string }{
		{"1/3", "1/6"},
		{"-7/4", "5/8"},
		{"0", "123/7"},
		{"22/7", "-22/7"},
		{"100000000000000000000/3", "1/100000000000000000000"},
	}
	for _, c := range cases {
		a := NewFrac(ratModel(t, c.a).Num(), ratModel(t, c.a).Denom())
		b := NewFrac(ratModel(t, c.b).Num(), ratModel(t, c.b).Denom())
		ra, rb := ratModel(t, c.a), ratModel(t, c.b)
		fracMustRat(t, a.Add(b), new(big.Rat).Add(ra, rb), "add "+c.a+"+"+c.b)
		fracMustRat(t, a.Sub(b), new(big.Rat).Sub(ra, rb), "sub "+c.a+"-"+c.b)
		fracMustRat(t, a.Mul(b), new(big.Rat).Mul(ra, rb), "mul "+c.a+"*"+c.b)
		if got, want := a.Cmp(b), ra.Cmp(rb); got != want {
			t.Fatalf("cmp %s %s: got %d want %d", c.a, c.b, got, want)
		}
	}
}

// ---------- 半偶舍入：已知样例 + 独立模型对照 ----------

func TestRoundHalfEvenKnownCases(t *testing.T) {
	cases := []struct {
		in    string
		scale int
		want  string
		rel   HalfRelation
	}{
		{"5/2", 0, "2", ExactlyHalf},      // 2.5 → 2（偶）
		{"3/2", 0, "2", ExactlyHalf},      // 1.5 → 2
		{"7/2", 0, "4", ExactlyHalf},      // 3.5 → 4（偶）
		{"-5/2", 0, "-2", ExactlyHalf},    // -2.5 → -2
		{"-3/2", 0, "-2", ExactlyHalf},    // -1.5 → -2
		{"1/8", 2, "12", ExactlyHalf},     // 0.125 → 0.12（恰半，12 为偶）
		{"9/40", 2, "22", ExactlyHalf},    // 0.225 → 0.22（恰半，22 为偶）
		{"27/200", 2, "14", ExactlyHalf},  // 0.135 → 0.14（恰半，13 奇进位）
		{"1/3", 2, "33", LessThanHalf},    // 0.333… → 0.33
		{"2/3", 2, "67", GreaterThanHalf}, // 0.666… → 0.67
		{"0", 2, "0", LessThanHalf},
		{"-1/200", 2, "0", ExactlyHalf}, // -0.005 → 0.00（恰半，0 为偶）
	}
	for _, c := range cases {
		r := ratModel(t, c.in)
		got, ev := RoundHalfEven(NewFrac(r.Num(), r.Denom()), c.scale)
		want, _ := new(big.Int).SetString(c.want, 10)
		if got.Cmp(want) != 0 {
			t.Errorf("round(%s, %d) = %s, want %s (evidence: %s)", c.in, c.scale, got, want, ev)
		}
		if ev.Relation != c.rel {
			t.Errorf("round(%s, %d) relation = %s, want %s", c.in, c.scale, ev.Relation, c.rel)
		}
	}
}

// TestRoundHalfEvenVsRatModel 用独立模型大规模对照。
func TestRoundHalfEvenVsRatModel(t *testing.T) {
	nums := []int64{-1000, -255, -25, -5, -1, 0, 1, 5, 15, 25, 125, 999, 123456789}
	dens := []int64{1, 2, 4, 8, 3, 7, 40, 200, 2000}
	for _, n := range nums {
		for _, d := range dens {
			for scale := 0; scale <= 4; scale++ {
				f := NewFrac(big.NewInt(n), big.NewInt(d))
				got, ev := RoundHalfEven(f, scale)
				want := modelHalfEven(t, big.NewRat(n, d), scale)
				if got.Cmp(want) != 0 {
					t.Fatalf("round(%d/%d, %d) = %s, model wants %s (evidence: %s)",
						n, d, scale, got, want, ev)
				}
				// 证据自洽：Exact 与 ScaledNum/ScaledDen 相差 10^scale 倍。
				scaled := new(big.Rat).SetFrac(ev.ScaledNum, ev.ScaledDen)
				exact := new(big.Rat).SetFrac(ev.Exact.Num(), ev.Exact.Den())
				pow := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil))
				if scaled.Cmp(new(big.Rat).Mul(exact, pow)) != 0 {
					t.Fatalf("evidence scaled mismatch for %d/%d scale %d", n, d, scale)
				}
				// 证据自洽：ScaledNum = Quotient*ScaledDen + Remainder。
				recon := new(big.Int).Add(new(big.Int).Mul(ev.Quotient, ev.ScaledDen), ev.Remainder)
				if recon.Cmp(ev.ScaledNum) != 0 {
					t.Fatalf("evidence divmod mismatch for %d/%d scale %d", n, d, scale)
				}
			}
		}
	}
}

// ---------- 结算：逐行换算、逐行舍入再合计 ----------

func dec(t *testing.T, s string) Frac {
	t.Helper()
	f, err := ParseDecimal(s)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestSettleMatchesIndependentModel(t *testing.T) {
	pct10 := NewFrac(big.NewInt(1), big.NewInt(10))
	lines := []Line{
		NewLine("a", ptr(FracFromInt(3)), ptr(dec(t, "19.99")), &pct10, nil),             // 3×19.99×0.9
		NewLine("b", ptr(FracFromInt(1)), ptr(dec(t, "0.05")), nil, ptr(dec(t, "0.01"))), // 0.05−0.01
		NewLine("c", ptr(dec(t, "0.5")), ptr(dec(t, "7.77")), nil, nil),                  // 0.5×7.77
	}
	rate := NewFrac(big.NewInt(717), big.NewInt(100)) // 1 源币 = 7.17 目标币
	res := Settle(lines, rate, 2)

	models := []struct {
		qty, price string
		pct, amt   *big.Rat
	}{
		{"3", "19.99", big.NewRat(1, 10), nil},
		{"1", "0.05", nil, ratModel(t, "0.01")},
		{"0.5", "7.77", nil, nil},
	}
	mrate := big.NewRat(717, 100)
	total := big.NewInt(0)
	for i, m := range models {
		net := modelNet(ratModel(t, m.qty), ratModel(t, m.price), m.pct, m.amt)
		conv := new(big.Rat).Mul(net, mrate)
		// 核对换算前精确值（分子/分母）。
		fracMustRat(t, res.Lines[i].Converted, conv, "converted line "+res.Lines[i].LineID)
		// 核对舍入结果。
		want := modelHalfEven(t, conv, 2)
		if res.Lines[i].MinorUnits.Cmp(want) != 0 {
			t.Fatalf("line %s minor = %s, model wants %s (evidence: %s)",
				res.Lines[i].LineID, res.Lines[i].MinorUnits, want, res.Lines[i].Evidence)
		}
		total.Add(total, want)
	}
	if res.Total.Cmp(total) != 0 {
		t.Fatalf("total = %s, model wants %s", res.Total, total)
	}
	// 合计必须等于逐行舍入后之和，而非整体舍入。
	sumExact := big.NewRat(0, 1)
	for _, m := range models {
		sumExact.Add(sumExact, new(big.Rat).Mul(modelNet(ratModel(t, m.qty), ratModel(t, m.price), m.pct, m.amt), mrate))
	}
	_ = sumExact // 整体精确值仅用于说明；合计以逐行舍入为准。
}

// ---------- 优惠顺序：先百分比后固定减免 ----------

func TestDiscountOrderPercentThenFixed(t *testing.T) {
	pct := NewFrac(big.NewInt(1), big.NewInt(4)) // 七五折
	amt := dec(t, "10")
	line := NewLine("x", ptr(FracFromInt(1)), ptr(dec(t, "100")), &pct, &amt)
	// 先百分比：100×0.75=75，再减 10 → 65。
	fracMustRat(t, line.NetAmount(), big.NewRat(65, 1), "percent-then-fixed")
	// 若顺序相反（先减后折）会是 (100−10)×0.75=67.5，必须不同。
	if line.NetAmount().Cmp(NewFrac(big.NewInt(135), big.NewInt(2))) == 0 {
		t.Fatal("discount order appears to be fixed-then-percent")
	}
}

// ---------- 退款：重算剩余项并做差 ----------

func TestRefundRecomputesRemainingAndDiffs(t *testing.T) {
	pct := NewFrac(big.NewInt(1), big.NewInt(10))
	lines := []Line{
		NewLine("keep-1", ptr(FracFromInt(2)), ptr(dec(t, "33.33")), &pct, nil),
		NewLine("drop-1", ptr(FracFromInt(1)), ptr(dec(t, "12.345")), nil, nil),
		NewLine("keep-2", ptr(FracFromInt(5)), ptr(dec(t, "0.07")), nil, ptr(dec(t, "0.05"))),
	}
	rate := NewFrac(big.NewInt(689), big.NewInt(100)) // 6.89
	rr, err := Refund(lines, rate, 2, map[string]bool{"drop-1": true})
	if err != nil {
		t.Fatal(err)
	}
	// 独立模型：剩余行重算。
	mrate := big.NewRat(689, 100)
	remainingModel := []struct {
		qty, price string
		pct, amt   *big.Rat
	}{
		{"2", "33.33", big.NewRat(1, 10), nil},
		{"5", "0.07", nil, ratModel(t, "0.05")},
	}
	remTotal := big.NewInt(0)
	for _, m := range remainingModel {
		conv := new(big.Rat).Mul(modelNet(ratModel(t, m.qty), ratModel(t, m.price), m.pct, m.amt), mrate)
		remTotal.Add(remTotal, modelHalfEven(t, conv, 2))
	}
	if rr.Remaining.Total.Cmp(remTotal) != 0 {
		t.Fatalf("remaining total = %s, model wants %s", rr.Remaining.Total, remTotal)
	}
	// 退款额 = 原合计 − 剩余合计。
	wantRefund := new(big.Int).Sub(rr.Original.Total, rr.Remaining.Total)
	if rr.RefundMinorUnits.Cmp(wantRefund) != 0 {
		t.Fatalf("refund = %s, want %s", rr.RefundMinorUnits, wantRefund)
	}
	// 退款额一般不等于被退行单独舍入的金额（因为逐行舍入再合计），
	// 但这里只断言它与独立模型一致。
	dropConv := new(big.Rat).Mul(modelNet(ratModel(t, "1"), ratModel(t, "12.345"), nil, nil), mrate)
	dropMinor := modelHalfEven(t, dropConv, 2)
	t.Logf("original=%s remaining=%s refund=%s (drop line alone rounds to %s)",
		rr.Original.Total, rr.Remaining.Total, rr.RefundMinorUnits, dropMinor)
	// 剩余行数与退款行记录。
	if len(rr.Remaining.Lines) != 2 || len(rr.RefundedLineIDs) != 1 || rr.RefundedLineIDs[0] != "drop-1" {
		t.Fatalf("unexpected refund structure: %+v", rr.RefundedLineIDs)
	}
}

func TestRefundErrors(t *testing.T) {
	lines := []Line{NewLine("a", ptr(FracFromInt(1)), ptr(FracFromInt(1)), nil, nil)}
	if _, err := Refund(lines, FracFromInt(1), 2, map[string]bool{"ghost": true}); err == nil {
		t.Fatal("expected error for unknown refunded id")
	}
	dup := []Line{
		NewLine("a", ptr(FracFromInt(1)), ptr(FracFromInt(1)), nil, nil),
		NewLine("a", ptr(FracFromInt(1)), ptr(FracFromInt(1)), nil, nil),
	}
	if _, err := Refund(dup, FracFromInt(1), 2, nil); err == nil {
		t.Fatal("expected error for duplicate line id")
	}
}

func ptr(f Frac) *Frac { return &f }
