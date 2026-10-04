// Package tsfill maintains a time series with rational-valued samples and
// linearly fills internal missing runs whose length does not exceed m.
// Leading and trailing missing regions are never filled. Adding samples
// incrementally yields a Delta of retracted and added fill points.
package tsfill

import (
	"math/big"
	"sort"
)

// Point is a single filled value at time T.
type Point struct {
	T int64
	V *big.Rat
}

// Delta describes how the set of filled points changed after an update.
// Retracted holds previously emitted fill points that no longer apply
// (removed or superseded); Added holds new or replacement fill points.
type Delta struct {
	Retracted []Point
	Added     []Point
}

// Series is an incremental time series with gap filling.
type Series struct {
	m     int64
	times []int64            // sorted known sample times
	vals  map[int64]*big.Rat // known samples
	fills map[int64]*big.Rat // currently effective filled points
}

// New returns an empty Series that fills internal missing runs of length
// at most m. A negative m is treated as 0 (no filling).
func New(m int64) *Series {
	if m < 0 {
		m = 0
	}
	return &Series{
		m:     m,
		vals:  make(map[int64]*big.Rat),
		fills: make(map[int64]*big.Rat),
	}
}

// fillGap returns the linearly interpolated points strictly between known
// times a and b, or nil when the gap is empty or longer than m.
func (s *Series) fillGap(a, b int64) []Point {
	n := b - a - 1
	if n <= 0 || n > s.m {
		return nil
	}
	va, vb := s.vals[a], s.vals[b]
	span := new(big.Rat).SetInt64(b - a)
	out := make([]Point, 0, n)
	for i := int64(1); i <= n; i++ {
		// v = va + (vb-va) * i / (b-a), exact rational arithmetic.
		v := new(big.Rat).Sub(vb, va)
		v.Mul(v, new(big.Rat).SetInt64(i))
		v.Quo(v, span)
		v.Add(v, va)
		out = append(out, Point{T: a + i, V: v})
	}
	return out
}

// Add inserts (or replaces) the sample at time t and returns the Delta of
// fill points caused by the change. Only the gaps adjacent to t can be
// affected. The value is copied; the caller may reuse it.
func (s *Series) Add(t int64, v *big.Rat) Delta {
	v = new(big.Rat).Set(v)
	idx := sort.Search(len(s.times), func(i int) bool { return s.times[i] >= t })
	dup := idx < len(s.times) && s.times[idx] == t

	var lo, hi int64
	hasLo, hasHi := false, false
	if dup {
		if idx > 0 {
			lo, hasLo = s.times[idx-1], true
		}
		if idx+1 < len(s.times) {
			hi, hasHi = s.times[idx+1], true
		}
	} else {
		if idx > 0 {
			lo, hasLo = s.times[idx-1], true
		}
		if idx < len(s.times) {
			hi, hasHi = s.times[idx], true
		}
	}

	// Fills strictly inside (lo, hi) may change; collect the old ones.
	// Missing bounds mean -/+ infinity: fills only ever exist between
	// consecutive known samples, so the open interval is exact.
	old := make(map[int64]*big.Rat)
	for ft, fv := range s.fills {
		if (!hasLo || ft > lo) && (!hasHi || ft < hi) {
			old[ft] = fv
		}
	}

	// Apply the sample update.
	if dup {
		s.vals[t] = v
	} else {
		s.times = append(s.times, 0)
		copy(s.times[idx+1:], s.times[idx:])
		s.times[idx] = t
		s.vals[t] = v
	}

	// Recompute fills for the gaps adjacent to t.
	cur := make(map[int64]*big.Rat)
	if hasLo {
		for _, p := range s.fillGap(lo, t) {
			cur[p.T] = p.V
		}
	}
	if hasHi {
		for _, p := range s.fillGap(t, hi) {
			cur[p.T] = p.V
		}
	}

	var d Delta
	for ft, fv := range old {
		nv, ok := cur[ft]
		switch {
		case !ok:
			d.Retracted = append(d.Retracted, Point{T: ft, V: fv})
			delete(s.fills, ft)
		case nv.Cmp(fv) != 0:
			d.Retracted = append(d.Retracted, Point{T: ft, V: fv})
			d.Added = append(d.Added, Point{T: ft, V: nv})
			s.fills[ft] = nv
		}
	}
	for ft, nv := range cur {
		if _, ok := old[ft]; !ok {
			d.Added = append(d.Added, Point{T: ft, V: nv})
			s.fills[ft] = nv
		}
	}
	sortPoints(d.Retracted)
	sortPoints(d.Added)
	return d
}

// Fills returns the currently effective filled points, sorted by time.
func (s *Series) Fills() []Point {
	out := make([]Point, 0, len(s.fills))
	for t, v := range s.fills {
		out = append(out, Point{T: t, V: v})
	}
	sortPoints(out)
	return out
}

func sortPoints(ps []Point) {
	sort.Slice(ps, func(i, j int) bool { return ps[i].T < ps[j].T })
}

// FillAll recomputes every fill point from scratch for the given samples.
// It is the batch reference used to cross-check incremental results.
func FillAll(samples map[int64]*big.Rat, m int64) []Point {
	s := New(m)
	times := make([]int64, 0, len(samples))
	for t := range samples {
		times = append(times, t)
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	s.times = times
	for t, v := range samples {
		s.vals[t] = new(big.Rat).Set(v)
	}
	for i := 0; i+1 < len(times); i++ {
		for _, p := range s.fillGap(times[i], times[i+1]) {
			s.fills[p.T] = p.V
		}
	}
	return s.Fills()
}
