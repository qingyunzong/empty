package docset

// Rat is a rational number Num/Den, normalized so Den > 0 and the
// fraction is in lowest terms. It is used for thresholds, exact
// Jaccard scores and certified upper bounds so that all comparisons
// are exact (no floating point).
type Rat struct {
	Num int64
	Den int64
}

func gcd(a, b int64) int64 {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	if a == 0 {
		return 1
	}
	return a
}

// NewRat returns num/den normalized. It panics if den == 0.
func NewRat(num, den int64) Rat {
	if den == 0 {
		panic("docset: zero denominator")
	}
	if den < 0 {
		num, den = -num, -den
	}
	g := gcd(num, den)
	return Rat{Num: num / g, Den: den / g}
}

// cmp returns -1, 0 or +1 comparing r to o exactly.
func (r Rat) cmp(o Rat) int {
	l := r.Num * o.Den
	rt := o.Num * r.Den
	switch {
	case l < rt:
		return -1
	case l > rt:
		return 1
	default:
		return 0
	}
}

// jaccardRat converts an intersection/union pair into a score.
// The empty-empty case (union == 0) is defined as similarity 1.
func jaccardRat(inter, union int64) Rat {
	if union == 0 {
		return Rat{Num: 1, Den: 1}
	}
	return NewRat(inter, union)
}

// lengthBound is the certified upper bound on the Jaccard similarity
// between two sets known only by their sizes: min(a,b)/max(a,b).
// Two empty sets bound at 1 (they are exactly similar).
func lengthBound(a, b int64) Rat {
	lo, hi := a, b
	if lo > hi {
		lo, hi = hi, lo
	}
	if hi == 0 {
		return Rat{Num: 1, Den: 1}
	}
	return NewRat(lo, hi)
}
