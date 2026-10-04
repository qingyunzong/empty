// Package tsfill maintains a time series in which internal contiguous
// missing segments of length at most m are filled by linear
// interpolation. Leading and trailing missing indices are never filled.
//
// Values are exact rational numbers (*big.Rat). Samples can be added or
// updated incrementally; every update reports the retraction of stale
// emitted points and the addition of new ones, so a consumer can
// maintain the emitted series without recomputing it from scratch.
package tsfill

import (
	"math/big"
	"sort"
)

// Point is a single emitted value of the series.
type Point struct {
	Index int64
	Value *big.Rat
}

// Delta describes the change to the emitted series caused by one
// update. Retracted lists points that are no longer valid (with the
// values previously emitted for them); Added lists points that are now
// valid (with their new values). A point whose value changed appears in
// both lists. Both lists are sorted by index.
type Delta struct {
	Retracted []Point
	Added     []Point
}

// Empty reports whether the delta changes nothing.
func (d Delta) Empty() bool { return len(d.Retracted) == 0 && len(d.Added) == 0 }

// interp returns the linear interpolation between (a, va) and (b, vb)
// evaluated at k, computed exactly with rational arithmetic.
func interp(va, vb *big.Rat, a, b, k int64) *big.Rat {
	t := new(big.Rat).SetFrac64(k-a, b-a)
	d := new(big.Rat).Sub(vb, va)
	return new(big.Rat).Add(va, d.Mul(d, t))
}

// fillSegment appends the interpolated points strictly between the
// observed indices a and b to out, if the gap length is at most m.
func fillSegment(out []Point, vals map[int64]*big.Rat, a, b, m int64) []Point {
	if b-a-1 > m {
		return out
	}
	for k := a + 1; k < b; k++ {
		out = append(out, Point{k, interp(vals[a], vals[b], a, b, k)})
	}
	return out
}

// Fill computes the complete emitted series for the given samples:
// every observed point plus the linear interpolation of every internal
// contiguous missing segment whose length is at most m. Indices before
// the first and after the last observed sample are never emitted.
// The result is sorted by index.
func Fill(samples map[int64]*big.Rat, m int64) []Point {
	idx := make([]int64, 0, len(samples))
	for i := range samples {
		idx = append(idx, i)
	}
	sort.Slice(idx, func(i, j int) bool { return idx[i] < idx[j] })

	var out []Point
	for pos, i := range idx {
		out = append(out, Point{i, new(big.Rat).Set(samples[i])})
		if pos+1 < len(idx) {
			out = fillSegment(out, samples, i, idx[pos+1], m)
		}
	}
	return out
}
