// Package preimage implements piecewise affine maps over finite integer
// domains and exact preimage queries of output intervals.
//
// All intervals are canonical half-open integer intervals [Lo, Hi).
// Affine maps use floor rounding: y = floor((A*x + B) / C) with C > 0.
// Coefficients A may be negative (direction flip) or zero (constant).
package preimage

import "sort"

// Interval is a canonical half-open integer interval [Lo, Hi).
// The zero value Interval{0, 0} is the canonical empty interval.
type Interval struct {
	Lo int64
	Hi int64
}

// Empty reports whether the interval contains no integers.
func (iv Interval) Empty() bool { return iv.Lo >= iv.Hi }

// Len returns the number of integers in the interval.
func (iv Interval) Len() int64 {
	if iv.Empty() {
		return 0
	}
	return iv.Hi - iv.Lo
}

// Contains reports whether x lies in [Lo, Hi).
func (iv Interval) Contains(x int64) bool { return x >= iv.Lo && x < iv.Hi }

// Intersect returns the intersection of two intervals, canonical empty if disjoint.
func Intersect(a, b Interval) Interval {
	lo := max(a.Lo, b.Lo)
	hi := min(a.Hi, b.Hi)
	if lo >= hi {
		return Interval{}
	}
	return Interval{Lo: lo, Hi: hi}
}

// Canonicalize sorts intervals and merges overlapping or adjacent ones,
// yielding the unique canonical representation of the same integer set.
func Canonicalize(ivs []Interval) []Interval {
	out := make([]Interval, 0, len(ivs))
	for _, iv := range ivs {
		if !iv.Empty() {
			out = append(out, iv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Lo < out[j].Lo })
	merged := out[:0]
	for _, iv := range out {
		if n := len(merged); n > 0 && iv.Lo <= merged[n-1].Hi {
			if iv.Hi > merged[n-1].Hi {
				merged[n-1].Hi = iv.Hi
			}
			continue
		}
		merged = append(merged, iv)
	}
	return merged
}
