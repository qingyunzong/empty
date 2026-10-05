// Package trendlib maintains bitemporal integer sample series and answers
// exact rational linear-regression queries over half-open business-time
// ranges as of a chosen commit version.
package trendlib

import (
	"math/big"
	"sort"
)

// Sample is a single integer observation at a business time. Multiple
// samples may share the same time.
type Sample struct {
	T int64 `json:"t"`
	V int64 `json:"v"`
}

// aggregates holds the exact running sums needed for least-squares
// regression over a set of rational points.
type aggregates struct {
	n   *big.Rat
	sx  *big.Rat
	sy  *big.Rat
	sxx *big.Rat
	sxy *big.Rat
	syy *big.Rat
}

func newAggregates() aggregates {
	z := func() *big.Rat { return new(big.Rat) }
	return aggregates{z(), z(), z(), z(), z(), z()}
}

func (a aggregates) clone() aggregates {
	c := func(r *big.Rat) *big.Rat { return new(big.Rat).Set(r) }
	return aggregates{c(a.n), c(a.sx), c(a.sy), c(a.sxx), c(a.sxy), c(a.syy)}
}

func (a aggregates) sub(b aggregates) aggregates {
	s := func(x, y *big.Rat) *big.Rat { return new(big.Rat).Sub(x, y) }
	return aggregates{s(a.n, b.n), s(a.sx, b.sx), s(a.sy, b.sy), s(a.sxx, b.sxx), s(a.sxy, b.sxy), s(a.syy, b.syy)}
}

var ratOne = big.NewRat(1, 1)

func (a *aggregates) addPoint(x, y *big.Rat) {
	a.n.Add(a.n, ratOne)
	a.sx.Add(a.sx, x)
	a.sy.Add(a.sy, y)
	a.sxx.Add(a.sxx, new(big.Rat).Mul(x, x))
	a.sxy.Add(a.sxy, new(big.Rat).Mul(x, y))
	a.syy.Add(a.syy, new(big.Rat).Mul(y, y))
}

// regress computes the least-squares slope and residual sum of squares from
// aggregates. The slope is nil when the x variance is zero (fewer than two
// distinct x values); in that case rss is the sum of squared deviations
// from the mean, the best constant fit.
func regress(a aggregates) (slope, rss *big.Rat) {
	if a.n.Sign() == 0 {
		return nil, new(big.Rat)
	}
	den := new(big.Rat).Mul(a.n, a.sxx)
	den.Sub(den, new(big.Rat).Mul(a.sx, a.sx))
	if den.Sign() == 0 {
		mean := new(big.Rat).Quo(a.sy, a.n)
		rss = new(big.Rat).Mul(a.sy, mean)
		rss.Sub(new(big.Rat).Set(a.syy), rss)
		return nil, rss
	}
	num := new(big.Rat).Mul(a.n, a.sxy)
	num.Sub(num, new(big.Rat).Mul(a.sx, a.sy))
	b := new(big.Rat).Quo(num, den)

	intercept := new(big.Rat).Mul(b, a.sx)
	intercept.Sub(new(big.Rat).Set(a.sy), intercept)
	intercept.Quo(intercept, a.n)

	// rss = syy - 2*c*sy - 2*b*sxy + c^2*n + 2*c*b*sx + b^2*sxx
	two := big.NewRat(2, 1)
	rss = new(big.Rat).Set(a.syy)
	rss.Sub(rss, new(big.Rat).Mul(two, new(big.Rat).Mul(intercept, a.sy)))
	rss.Sub(rss, new(big.Rat).Mul(two, new(big.Rat).Mul(b, a.sxy)))
	rss.Add(rss, new(big.Rat).Mul(new(big.Rat).Mul(intercept, intercept), a.n))
	rss.Add(rss, new(big.Rat).Mul(two, new(big.Rat).Mul(new(big.Rat).Mul(intercept, b), a.sx)))
	rss.Add(rss, new(big.Rat).Mul(new(big.Rat).Mul(b, b), a.sxx))
	return b, rss
}

// point is a rational sample: either an original integer sample or a
// fraction interpolated at a query range edge.
type point struct {
	x *big.Rat
	y *big.Rat
}

// meanAt returns the time and mean value of all samples sharing samples[i].T.
func meanAt(samples []Sample, i int) (int64, *big.Rat) {
	t := samples[i].T
	lo, hi := i, i
	for lo > 0 && samples[lo-1].T == t {
		lo--
	}
	for hi+1 < len(samples) && samples[hi+1].T == t {
		hi++
	}
	sum := new(big.Rat)
	for k := lo; k <= hi; k++ {
		sum.Add(sum, new(big.Rat).SetInt64(samples[k].V))
	}
	return t, sum.Quo(sum, new(big.Rat).SetInt64(int64(hi-lo+1)))
}

// interpAt returns the linearly interpolated point at edge e, or false when
// a sample exists exactly at e or when e lacks samples on either side.
// Duplicate timestamps are averaged before interpolating.
func interpAt(samples []Sample, e int64) (point, bool) {
	j := sort.Search(len(samples), func(i int) bool { return samples[i].T >= e })
	if j < len(samples) && samples[j].T == e {
		return point{}, false
	}
	if j == 0 || j == len(samples) {
		return point{}, false
	}
	t1, y1 := meanAt(samples, j-1)
	t2, y2 := meanAt(samples, j)
	// y = y1 + (y2-y1) * (e-t1) / (t2-t1)
	dy := new(big.Rat).Sub(y2, y1)
	dy.Mul(dy, new(big.Rat).SetInt64(e-t1))
	dy.Quo(dy, new(big.Rat).SetInt64(t2-t1))
	return point{big.NewRat(e, 1), dy.Add(dy, y1)}, true
}

// versionData is an immutable snapshot of one commit version: samples
// sorted by business time plus prefix regression aggregates, so a range
// query is a prefix difference plus interpolated edge points.
type versionData struct {
	samples []Sample
	prefix  []aggregates
}

func newVersionData(samples []Sample) *versionData {
	vd := &versionData{samples: samples, prefix: make([]aggregates, len(samples)+1)}
	vd.prefix[0] = newAggregates()
	for i, s := range samples {
		vd.prefix[i+1] = vd.prefix[i].clone()
		vd.prefix[i+1].addPoint(new(big.Rat).SetInt64(s.T), new(big.Rat).SetInt64(s.V))
	}
	return vd
}

func (vd *versionData) query(lo, hi int64) (slope, rss *big.Rat) {
	if lo >= hi {
		return nil, new(big.Rat)
	}
	i0 := sort.Search(len(vd.samples), func(i int) bool { return vd.samples[i].T >= lo })
	i1 := sort.Search(len(vd.samples), func(i int) bool { return vd.samples[i].T >= hi })
	agg := vd.prefix[i1].sub(vd.prefix[i0])
	if p, ok := interpAt(vd.samples, lo); ok {
		agg.addPoint(p.x, p.y)
	}
	if p, ok := interpAt(vd.samples, hi); ok {
		agg.addPoint(p.x, p.y)
	}
	return regress(agg)
}
