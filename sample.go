package monitor

import "math/big"

// Sample is a single timestamped observation. A missing sample cuts the
// piecewise-linear signal: no segment spans a missing endpoint, and no
// interpolation ever crosses the hole.
type Sample struct {
	Time    int64
	Value   *big.Rat // nil when Missing
	Missing bool
	Version uint64
}

func (s Sample) clone() Sample {
	c := s
	if s.Value != nil {
		c.Value = new(big.Rat).Set(s.Value)
	}
	return c
}

// interp evaluates the linear segment (t1,v1)-(t2,v2) at time t.
func interp(t1 int64, v1 *big.Rat, t2 int64, v2 *big.Rat, t int64) *big.Rat {
	r := new(big.Rat).Sub(v2, v1)
	r.Mul(r, big.NewRat(t-t1, t2-t1))
	return r.Add(r, v1)
}

// segIntegral returns the exact trapezoid integral of the full segment.
func segIntegral(t1 int64, v1 *big.Rat, t2 int64, v2 *big.Rat) *big.Rat {
	area := new(big.Rat).Add(v1, v2)
	area.Mul(area, big.NewRat(1, 2))
	return area.Mul(area, big.NewRat(t2-t1, 1))
}

// segIntegralClipped returns the exact integral of the linear segment
// (t1,v1)-(t2,v2) restricted to [a,b].
func segIntegralClipped(t1 int64, v1 *big.Rat, t2 int64, v2 *big.Rat, a, b int64) *big.Rat {
	if t2 <= t1 {
		return new(big.Rat)
	}
	lo := max(t1, a)
	hi := min(t2, b)
	if hi <= lo {
		return new(big.Rat)
	}
	area := new(big.Rat).Add(interp(t1, v1, t2, v2, lo), interp(t1, v1, t2, v2, hi))
	area.Mul(area, big.NewRat(1, 2))
	return area.Mul(area, big.NewRat(hi-lo, 1))
}
