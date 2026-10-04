// Package trend maintains integer time-series samples and answers exact
// rational linear-regression statistics (slope and residual sum of squares)
// over business-time ranges and commit versions.
package trend

import (
	"fmt"
	"math/big"
	"sort"
)

// Sample is an integer observation at a business time. Duplicate timestamps
// are allowed.
type Sample struct {
	T int64
	V int64
}

// Stats holds exact regression results. Slope and Intercept are nil when the
// x-variance is zero (or there is no data); RSS is nil only when there is no
// data. With zero x-variance RSS is the sum of squared deviations from the
// mean of y, i.e. the residual of the best constant fit.
type Stats struct {
	Count     int
	Slope     *big.Rat
	Intercept *big.Rat
	RSS       *big.Rat
}

func (s Stats) String() string {
	return fmt.Sprintf("Stats{n=%d slope=%s intercept=%s rss=%s}",
		s.Count, ratStr(s.Slope), ratStr(s.Intercept), ratStr(s.RSS))
}

func ratStr(r *big.Rat) string {
	if r == nil {
		return "<nil>"
	}
	return r.RatString()
}

// Equal reports whether two Stats are exactly equal.
func (s Stats) Equal(o Stats) bool {
	return s.Count == o.Count &&
		ratEq(s.Slope, o.Slope) &&
		ratEq(s.Intercept, o.Intercept) &&
		ratEq(s.RSS, o.RSS)
}

func ratEq(a, b *big.Rat) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Cmp(b) == 0
}

// point is a sample position with a possibly fractional (interpolated) value.
type point struct {
	x int64
	y *big.Rat
}

// selectPoints returns the points of samples (sorted by T) effective for the
// closed query range [from, to]. Samples inside the range participate
// directly; when no sample sits exactly on an edge, a linearly interpolated
// fractional point at that edge participates instead. Points outside the
// sample span are never extrapolated.
func selectPoints(samples []Sample, from, to int64) []point {
	if from > to {
		return nil
	}
	pts := make([]point, 0, 8)
	lo := sort.Search(len(samples), func(i int) bool { return samples[i].T >= from })
	hi := sort.Search(len(samples), func(i int) bool { return samples[i].T > to })
	if lo >= len(samples) || samples[lo].T != from {
		if p, ok := interpolate(samples, lo, from); ok {
			pts = append(pts, p)
		}
	}
	for i := lo; i < hi; i++ {
		pts = append(pts, point{samples[i].T, new(big.Rat).SetInt64(samples[i].V)})
	}
	if to > from && (hi == 0 || samples[hi-1].T != to) {
		if p, ok := interpolate(samples, hi, to); ok {
			pts = append(pts, p)
		}
	}
	return pts
}

// interpolate computes the linear interpolation at t, where idx is the first
// index with samples[idx].T > t (so samples[idx-1].T < t). It returns false
// when t lies outside the sample span.
func interpolate(samples []Sample, idx int, t int64) (point, bool) {
	if idx == 0 || idx >= len(samples) {
		return point{}, false
	}
	s0, s1 := samples[idx-1], samples[idx]
	y0 := new(big.Rat).SetInt64(s0.V)
	y1 := new(big.Rat).SetInt64(s1.V)
	dy := new(big.Rat).Sub(y1, y0)
	dy.Mul(dy, new(big.Rat).SetInt64(t-s0.T))
	dy.Quo(dy, new(big.Rat).SetInt64(s1.T-s0.T))
	return point{t, new(big.Rat).Add(y0, dy)}, true
}

// aggregates accumulates the exact rational sums needed for regression.
type aggregates struct {
	n                     int64
	sx, sy, sxx, sxy, syy *big.Rat
}

func newAggregates() *aggregates {
	return &aggregates{
		sx:  new(big.Rat),
		sy:  new(big.Rat),
		sxx: new(big.Rat),
		sxy: new(big.Rat),
		syy: new(big.Rat),
	}
}

func (a *aggregates) add(x int64, y *big.Rat) {
	a.n++
	rx := new(big.Rat).SetInt64(x)
	a.sx.Add(a.sx, rx)
	a.sy.Add(a.sy, y)
	a.sxx.Add(a.sxx, new(big.Rat).Mul(rx, rx))
	a.sxy.Add(a.sxy, new(big.Rat).Mul(rx, y))
	a.syy.Add(a.syy, new(big.Rat).Mul(y, y))
}

// stats derives regression results from the aggregate sums. RSS uses the
// exact identity RSS = syy - intercept*sy - slope*sxy.
func (a *aggregates) stats() Stats {
	st := Stats{Count: int(a.n)}
	if a.n == 0 {
		return st
	}
	n := new(big.Rat).SetInt64(a.n)
	mean := new(big.Rat).Quo(a.sy, n)
	den := new(big.Rat).Sub(new(big.Rat).Mul(n, a.sxx), new(big.Rat).Mul(a.sx, a.sx))
	if den.Sign() == 0 {
		// Zero x-variance: no slope; best constant fit is the mean.
		st.RSS = new(big.Rat).Sub(a.syy, new(big.Rat).Mul(mean, a.sy))
		return st
	}
	num := new(big.Rat).Sub(new(big.Rat).Mul(n, a.sxy), new(big.Rat).Mul(a.sx, a.sy))
	slope := new(big.Rat).Quo(num, den)
	intercept := new(big.Rat).Sub(a.sy, new(big.Rat).Mul(slope, a.sx))
	intercept.Quo(intercept, n)
	st.Slope = slope
	st.Intercept = intercept
	rss := new(big.Rat).Sub(a.syy, new(big.Rat).Mul(intercept, a.sy))
	rss.Sub(rss, new(big.Rat).Mul(slope, a.sxy))
	st.RSS = rss
	return st
}

// directStats computes regression statistics by summing per-point residuals
// directly with rational arithmetic. It is the independent reference model
// used to cross-check aggregate-based computations.
func directStats(pts []point) Stats {
	st := Stats{Count: len(pts)}
	if len(pts) == 0 {
		return st
	}
	agg := newAggregates()
	for _, p := range pts {
		agg.add(p.x, p.y)
	}
	n := new(big.Rat).SetInt64(int64(len(pts)))
	mean := new(big.Rat).Quo(agg.sy, n)
	den := new(big.Rat).Sub(new(big.Rat).Mul(n, agg.sxx), new(big.Rat).Mul(agg.sx, agg.sx))
	if den.Sign() == 0 {
		rss := new(big.Rat)
		for _, p := range pts {
			d := new(big.Rat).Sub(p.y, mean)
			rss.Add(rss, new(big.Rat).Mul(d, d))
		}
		st.RSS = rss
		return st
	}
	num := new(big.Rat).Sub(new(big.Rat).Mul(n, agg.sxy), new(big.Rat).Mul(agg.sx, agg.sy))
	slope := new(big.Rat).Quo(num, den)
	intercept := new(big.Rat).Sub(agg.sy, new(big.Rat).Mul(slope, agg.sx))
	intercept.Quo(intercept, n)
	st.Slope = slope
	st.Intercept = intercept
	rss := new(big.Rat)
	for _, p := range pts {
		d := new(big.Rat).Sub(p.y, intercept)
		d.Sub(d, new(big.Rat).Mul(slope, new(big.Rat).SetInt64(p.x)))
		rss.Add(rss, new(big.Rat).Mul(d, d))
	}
	st.RSS = rss
	return st
}
