package billing

import "math/big"

// VerifyPerUnit independently recomputes a billing run tick by tick over
// [start, end) — feasible for small time domains — and checks that the
// per-tick sum of price(t) * usage(t) equals res.Total exactly, and that
// the ticks with usage but no price reproduce res.Unpriced exactly.
func VerifyPerUnit(pb *PriceBook, uc *UsageCurve, start, end int64, res *Result) bool {
	sum := new(big.Rat)
	var unpriced []Interval
	inGap := false
	gapStart := start
	for t := start; t < end; t++ {
		price, hasPrice := pb.PriceAt(t)
		units, hasUsage := uc.UsageAt(t)
		if hasPrice && hasUsage {
			sum.Add(sum, new(big.Rat).Mul(price, big.NewRat(units, 1)))
		}
		switch {
		case hasUsage && !hasPrice && !inGap:
			gapStart, inGap = t, true
		case inGap && (!hasUsage || hasPrice):
			unpriced = append(unpriced, Interval{gapStart, t})
			inGap = false
		}
	}
	if inGap {
		unpriced = append(unpriced, Interval{gapStart, end})
	}
	if sum.Cmp(res.Total) != 0 {
		return false
	}
	if len(unpriced) != len(res.Unpriced) {
		return false
	}
	for i := range unpriced {
		if unpriced[i] != res.Unpriced[i] {
			return false
		}
	}
	return true
}
