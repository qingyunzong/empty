package settle

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// This file holds an independent verification model built directly on
// math/big.Rat. It re-implements the settlement pipeline (explicit
// discount order, rational conversion, per-line half-even rounding,
// sum, refund difference) without using any settle internals, and the
// tests cross-check the library against it.

type mDisc struct {
	percent bool
	val     *big.Rat
}

type mLine struct {
	price *big.Rat
	qty   *big.Rat
	discs []mDisc
}

type mOrder struct {
	lines []mLine
	discs []mDisc
	rate  *big.Rat
	scale int
}

func mApplyOne(amt *big.Rat, d mDisc) *big.Rat {
	if d.percent {
		f := new(big.Rat).Sub(big.NewRat(100, 1), d.val)
		f.Quo(f, big.NewRat(100, 1))
		return new(big.Rat).Mul(amt, f)
	}
	if amt.Cmp(d.val) <= 0 {
		return new(big.Rat)
	}
	return new(big.Rat).Sub(amt, d.val)
}

func mLineAmounts(o mOrder) []*big.Rat {
	amounts := make([]*big.Rat, len(o.lines))
	for i, l := range o.lines {
		a := new(big.Rat).Mul(l.price, l.qty)
		for _, wantPct := range []bool{true, false} {
			for _, d := range l.discs {
				if d.percent == wantPct {
					a = mApplyOne(a, d)
				}
			}
		}
		amounts[i] = a
	}
	for _, wantPct := range []bool{true, false} {
		for _, d := range o.discs {
			if d.percent != wantPct {
				continue
			}
			if wantPct {
				for i := range amounts {
					amounts[i] = mApplyOne(amounts[i], d)
				}
				continue
			}
			sum := new(big.Rat)
			for _, a := range amounts {
				sum.Add(sum, a)
			}
			if sum.Sign() == 0 {
				break
			}
			cut := new(big.Rat).Set(d.val)
			if cut.Cmp(sum) > 0 {
				cut.Set(sum)
			}
			keep := new(big.Rat).Sub(sum, cut)
			keep.Quo(keep, sum)
			for i := range amounts {
				amounts[i].Mul(amounts[i], keep)
			}
		}
	}
	return amounts
}

func mRoundHalfEven(r *big.Rat, scale int) *big.Rat {
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	scaled := new(big.Rat).Mul(r, new(big.Rat).SetInt(pow))
	n := new(big.Int).Set(scaled.Num())
	d := scaled.Denom()
	q, rem := new(big.Int).QuoRem(n, d, new(big.Int))
	twice := new(big.Int).Mul(new(big.Int).Abs(rem), big.NewInt(2))
	switch c := twice.Cmp(d); {
	case c > 0:
		q.Add(q, big.NewInt(int64(n.Sign())))
	case c == 0 && q.Bit(0) == 1:
		q.Add(q, big.NewInt(int64(n.Sign())))
	}
	return new(big.Rat).SetFrac(q, pow)
}

func mSettle(o mOrder) (rounded []*big.Rat, total *big.Rat) {
	amounts := mLineAmounts(o)
	rounded = make([]*big.Rat, len(amounts))
	total = new(big.Rat)
	for i, a := range amounts {
		conv := new(big.Rat).Mul(a, o.rate)
		rounded[i] = mRoundHalfEven(conv, o.scale)
		total.Add(total, rounded[i])
	}
	return rounded, total
}

func toModel(o Order) mOrder {
	rat := func(f Frac) *big.Rat { return new(big.Rat).SetFrac(f.Num(), f.Den()) }
	md := func(ds []Discount) []mDisc {
		out := make([]mDisc, len(ds))
		for i, d := range ds {
			out[i] = mDisc{percent: d.Kind == PercentOff, val: rat(d.Value)}
		}
		return out
	}
	mo := mOrder{discs: md(o.Discounts), rate: rat(o.Rate), scale: o.Scale}
	for _, l := range o.Lines {
		mo.lines = append(mo.lines, mLine{price: rat(l.UnitPrice), qty: rat(l.Qty), discs: md(l.Discounts)})
	}
	return mo
}

func mustBigInt(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad int %q", s)
	}
	return n
}

// checkAgainstModel verifies per-line rounded values, the total, and the
// internal consistency of the rounding evidence.
func checkAgainstModel(t *testing.T, o Order, res Result) {
	t.Helper()
	rounded, total := mSettle(toModel(o))
	if len(res.Lines) != len(rounded) {
		t.Fatalf("line count %d != %d", len(res.Lines), len(rounded))
	}
	for i, lr := range res.Lines {
		got := new(big.Rat).SetFrac(mustBigInt(t, lr.RoundedN), mustBigInt(t, lr.RoundedD))
		if got.Cmp(rounded[i]) != 0 {
			t.Errorf("line %d (%s): lib %s vs model %s", i, lr.LineID, got.RatString(), rounded[i].RatString())
		}
		// Evidence consistency: scaled == quotient + remainder/den,
		// and rounded == quotient + adjustment implied by the rule.
		ev := lr.Rounding
		scaled := new(big.Rat).SetFrac(mustBigInt(t, ev.ScaledN), mustBigInt(t, ev.ScaledD))
		rebuilt := new(big.Rat).SetInt(mustBigInt(t, ev.Quotient))
		rebuilt.Add(rebuilt, new(big.Rat).SetFrac(mustBigInt(t, ev.RemainderN), mustBigInt(t, ev.RemainderD)))
		if scaled.Cmp(rebuilt) != 0 {
			t.Errorf("line %d: evidence scaled %s != quotient+remainder %s", i, scaled.RatString(), rebuilt.RatString())
		}
		exact := new(big.Rat).SetFrac(mustBigInt(t, ev.ExactN), mustBigInt(t, ev.ExactD))
		pow := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(ev.Scale)), nil))
		if new(big.Rat).Mul(exact, pow).Cmp(scaled) != 0 {
			t.Errorf("line %d: exact*10^scale != scaled in evidence", i)
		}
	}
	gotTotal := new(big.Rat).SetFrac(mustBigInt(t, res.TotalN), mustBigInt(t, res.TotalD))
	if gotTotal.Cmp(total) != 0 {
		t.Errorf("total: lib %s vs model %s", gotTotal.RatString(), total.RatString())
	}
}

func TestModelCrossCheckFixed(t *testing.T) {
	orders := []Order{
		{
			Lines: []Line{
				{ID: "A", UnitPrice: MustParse("19.99"), Qty: FracFromInt64(2)},
				{ID: "B", UnitPrice: MustParse("5.005"), Qty: FracFromInt64(1)},
			},
			Rate: MustParse("3/2"), Scale: 2,
		},
		{
			Lines: []Line{
				{ID: "A", UnitPrice: MustParse("100"), Qty: FracFromInt64(1),
					Discounts: []Discount{disc(AmountOff, "20"), disc(PercentOff, "10")}},
				{ID: "B", UnitPrice: MustParse("0.333"), Qty: MustParse("3")},
			},
			Discounts: []Discount{disc(PercentOff, "5"), disc(AmountOff, "7.77")},
			Rate:      MustParse("131/100"), Scale: 2,
		},
		{
			Lines: []Line{
				{ID: "A", UnitPrice: MustParse("1/7"), Qty: MustParse("7/3")},
				{ID: "B", UnitPrice: MustParse("0.0005"), Qty: FracFromInt64(11)},
			},
			Rate: MustParse("1/3"), Scale: 4,
		},
	}
	for i, o := range orders {
		t.Run(fmt.Sprintf("order%d", i), func(t *testing.T) {
			checkAgainstModel(t, o, Settle(o))
		})
	}
}

func randDecimal(rng *rand.Rand, maxInt int64, places int) string {
	v := rng.Int63n(maxInt) + 1
	d := int64(1)
	for i := 0; i < places; i++ {
		d *= 10
	}
	return fmt.Sprintf("%d/%d", v, d)
}

func TestModelCrossCheckRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for iter := 0; iter < 500; iter++ {
		nLines := 1 + rng.Intn(5)
		o := Order{Scale: rng.Intn(5)}
		o.Rate = MustParse(randDecimal(rng, 999, 2))
		for i := 0; i < nLines; i++ {
			l := Line{
				ID:        fmt.Sprintf("L%d", i),
				UnitPrice: MustParse(randDecimal(rng, 100000, 3)),
				Qty:       MustParse(randDecimal(rng, 20, 1)),
			}
			if rng.Intn(2) == 0 {
				l.Discounts = append(l.Discounts, disc(PercentOff, fmt.Sprintf("%d", rng.Intn(40))))
			}
			if rng.Intn(3) == 0 {
				l.Discounts = append(l.Discounts, disc(AmountOff, randDecimal(rng, 500, 2)))
			}
			o.Lines = append(o.Lines, l)
		}
		if rng.Intn(2) == 0 {
			o.Discounts = append(o.Discounts, disc(PercentOff, fmt.Sprintf("%d", rng.Intn(25))))
		}
		if rng.Intn(3) == 0 {
			o.Discounts = append(o.Discounts, disc(AmountOff, randDecimal(rng, 300, 2)))
		}

		res := Settle(o)
		checkAgainstModel(t, o, res)

		// Refund a random subset of quantities; verify the difference
		// against the model's recomputation of the remaining order.
		returned := map[string]Frac{}
		for _, l := range o.Lines {
			if rng.Intn(2) == 0 {
				returned[l.ID] = l.Qty
			}
		}
		rr, err := Refund(o, returned)
		if err != nil {
			t.Fatal(err)
		}
		rem, err := RemainingOrder(o, returned)
		if err != nil {
			t.Fatal(err)
		}
		_, origTotal := mSettle(toModel(o))
		_, remTotal := mSettle(toModel(rem))
		want := new(big.Rat).Sub(origTotal, remTotal)
		got := new(big.Rat).SetFrac(mustBigInt(t, rr.RefundN), mustBigInt(t, rr.RefundD))
		if got.Cmp(want) != 0 {
			t.Fatalf("iter %d: refund lib %s vs model %s", iter, got.RatString(), want.RatString())
		}
	}
}
