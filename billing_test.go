package billing

import (
	"math/big"
	"strings"
	"testing"
)

func rat(n, d int64) *big.Rat { return big.NewRat(n, d) }

func TestExactFractionalBreakdown(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(0, 10, rat(1, 3)) // 1/3 per unit per tick
	uc := &UsageCurve{}
	uc.SetUsage(0, 10, 2)

	res := Bill(pb, uc, 0, 10)
	if !res.Complete() {
		t.Fatalf("expected complete run, unpriced=%v", res.Unpriced)
	}
	if len(res.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(res.Items))
	}
	li := res.Items[0]
	if li.Interval != (Interval{0, 10}) || li.Units != 2 {
		t.Fatalf("unexpected item: %v", li)
	}
	// 1/3 * 2 units * 10 ticks = 20/3, kept exact.
	if li.Amount.Cmp(rat(20, 3)) != 0 || res.Total.Cmp(rat(20, 3)) != 0 {
		t.Fatalf("amount=%s total=%s, want 20/3", li.Amount, res.Total)
	}
	// 20/3 = 6.6666... -> 667 cents.
	if got := res.TotalCents(); got != 667 {
		t.Fatalf("TotalCents=%d, want 667", got)
	}
}

func TestHalfOpenBoundaries(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(0, 5, rat(1, 1))
	uc := &UsageCurve{}
	uc.SetUsage(5, 10, 3)

	res := Bill(pb, uc, 0, 20)
	// Price [0,5) does not cover tick 5; the whole usage curve is unpriced.
	if res.Complete() {
		t.Fatal("expected incomplete run")
	}
	if len(res.Items) != 0 {
		t.Fatalf("expected no items, got %v", res.Items)
	}
	if len(res.Unpriced) != 1 || res.Unpriced[0] != (Interval{5, 10}) {
		t.Fatalf("unpriced=%v, want [[5,10)]", res.Unpriced)
	}
	if res.Total.Sign() != 0 {
		t.Fatalf("total=%s, want 0", res.Total)
	}
}

func TestMissingPriceReportedForWholeRun(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(2, 4, rat(1, 2))
	pb.SetPrice(8, 10, rat(1, 2))
	uc := &UsageCurve{}
	uc.SetUsage(0, 6, 1)
	uc.SetUsage(6, 12, 2)

	res := Bill(pb, uc, 0, 12)
	if res.Complete() {
		t.Fatal("expected incomplete run")
	}
	// Gaps [0,2), [4,8), [10,12) reported together for the whole run,
	// merged across adjacent usage segments.
	want := []Interval{{0, 2}, {4, 8}, {10, 12}}
	if len(res.Unpriced) != len(want) {
		t.Fatalf("unpriced=%v, want %v", res.Unpriced, want)
	}
	for i := range want {
		if res.Unpriced[i] != want[i] {
			t.Fatalf("unpriced=%v, want %v", res.Unpriced, want)
		}
	}
	// Priced parts still bill exactly: [2,4): 1/2*1*2=1; [8,10): 1/2*2*2=2.
	if res.Total.Cmp(rat(3, 1)) != 0 {
		t.Fatalf("total=%s, want 3", res.Total)
	}
}

func TestRetroactiveRepricing(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(0, 10, rat(1, 1))
	uc := &UsageCurve{}
	uc.SetUsage(0, 10, 1)

	before := Bill(pb, uc, 0, 10)
	if before.Total.Cmp(rat(10, 1)) != 0 {
		t.Fatalf("before total=%s, want 10", before.Total)
	}

	// Retroactively raise the price for past interval [3,6) to 5/2.
	pb.SetPrice(3, 6, rat(5, 2))
	after := Bill(pb, uc, 0, 10)
	if len(after.Items) != 3 {
		t.Fatalf("expected 3 items after repricing, got %v", after.Items)
	}
	// 1*1*3 + 5/2*1*3 + 1*1*4 = 3 + 15/2 + 4 = 29/2.
	if after.Total.Cmp(rat(29, 2)) != 0 {
		t.Fatalf("after total=%s, want 29/2", after.Total)
	}
	if after.Items[1].Interval != (Interval{3, 6}) || after.Items[1].UnitPrice.Cmp(rat(5, 2)) != 0 {
		t.Fatalf("repriced item wrong: %v", after.Items[1])
	}
	if !VerifyPerUnit(pb, uc, 0, 10, after) {
		t.Fatal("per-unit verification failed after repricing")
	}
}

func TestRoundHalfEvenCents(t *testing.T) {
	cases := []struct {
		amount *big.Rat
		want   int64
	}{
		{rat(1, 200), 0},   // 0.005 -> tie -> 0 (even)
		{rat(3, 200), 2},   // 0.015 -> tie -> 2 (even)
		{rat(5, 200), 2},   // 0.025 -> tie -> 2 (even)
		{rat(7, 200), 4},   // 0.035 -> tie -> 4 (even)
		{rat(-3, 200), -2}, // -0.015 -> tie -> -2 (even)
		{rat(-1, 200), 0},  // -0.005 -> tie -> 0 (even)
		{rat(7, 500), 1},   // 0.014 -> 1
		{rat(4, 250), 2},   // 0.016 -> 2
		{rat(20, 3), 667},  // 6.666... -> 667
		{rat(-20, 3), -667},
		{rat(0, 1), 0},
	}
	for _, c := range cases {
		if got := RoundHalfEvenCents(c.amount); got != c.want {
			t.Errorf("RoundHalfEvenCents(%s)=%d, want %d", c.amount.RatString(), got, c.want)
		}
	}
}

func TestVerifyPerUnit(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(0, 4, rat(2, 3))
	pb.SetPrice(6, 12, rat(7, 5))
	uc := &UsageCurve{}
	uc.SetUsage(1, 5, 3)
	uc.SetUsage(5, 12, 1)

	res := Bill(pb, uc, 0, 12)
	if !VerifyPerUnit(pb, uc, 0, 12, res) {
		t.Fatal("per-unit verification failed for genuine result")
	}

	// A tampered total must be caught.
	tampered := &Result{Items: res.Items, Unpriced: res.Unpriced, Total: rat(1, 1)}
	if VerifyPerUnit(pb, uc, 0, 12, tampered) {
		t.Fatal("per-unit verification accepted tampered total")
	}

	// A tampered unpriced list must be caught.
	tampered2 := &Result{Items: res.Items, Unpriced: nil, Total: new(big.Rat).Set(res.Total)}
	if VerifyPerUnit(pb, uc, 0, 12, tampered2) {
		t.Fatal("per-unit verification accepted tampered unpriced list")
	}
}

func TestDetailOutputsExactFractions(t *testing.T) {
	pb := &PriceBook{}
	pb.SetPrice(0, 3, rat(1, 3))
	uc := &UsageCurve{}
	uc.SetUsage(0, 5, 2)

	res := Bill(pb, uc, 0, 5)
	d := res.Detail()
	if !strings.Contains(d, "amount=2") || !strings.Contains(d, "price=1/3") {
		t.Fatalf("detail missing exact fractions:\n%s", d)
	}
	if !strings.Contains(d, "unpriced [3,5)") {
		t.Fatalf("detail missing unpriced interval:\n%s", d)
	}
	if !strings.Contains(d, "total=2 cents=200 (2.00)") {
		t.Fatalf("detail missing rounded total:\n%s", d)
	}
}
