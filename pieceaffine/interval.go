package pieceaffine

import "sort"

// Interval is a half-open integer interval [Lo, Hi). An interval with
// Lo >= Hi is empty. Half-open intervals are the canonical form used
// throughout the package: domains, query outputs and preimage results.
type Interval struct {
	Lo int64 `json:"lo"`
	Hi int64 `json:"hi"`
}

// Empty reports whether the interval contains no integer.
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

// intersect returns the overlap of two intervals (possibly empty).
func intersect(a, b Interval) Interval {
	lo := max(a.Lo, b.Lo)
	hi := min(a.Hi, b.Hi)
	return Interval{Lo: lo, Hi: hi}
}

// Canonical normalizes a set of intervals: empty intervals are dropped,
// the rest are sorted and overlapping or adjacent intervals are merged.
// The result is the unique canonical representation of the set.
func Canonical(ivs []Interval) []Interval {
	list := make([]Interval, 0, len(ivs))
	for _, iv := range ivs {
		if !iv.Empty() {
			list = append(list, iv)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Lo != list[j].Lo {
			return list[i].Lo < list[j].Lo
		}
		return list[i].Hi < list[j].Hi
	})
	var out []Interval
	for _, iv := range list {
		if n := len(out); n > 0 && iv.Lo <= out[n-1].Hi {
			if iv.Hi > out[n-1].Hi {
				out[n-1].Hi = iv.Hi
			}
			continue
		}
		out = append(out, iv)
	}
	return out
}
