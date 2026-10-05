// Package setlib maintains named sets of integers whose membership is
// expressed as unions of valid half-open intervals over a small integer
// domain, and answers multi-set intersection queries with source evidence.
package setlib

import "sort"

// Interval is a half-open interval [Lo, Hi). It is valid iff Lo < Hi.
type Interval struct {
	Lo, Hi int
}

// Valid reports whether the interval is non-empty.
func (iv Interval) Valid() bool { return iv.Lo < iv.Hi }

// Contains reports whether p lies in [Lo, Hi).
func (iv Interval) Contains(p int) bool { return iv.Lo <= p && p < iv.Hi }

// Overlaps reports whether a and b share at least one point.
func Overlaps(a, b Interval) bool { return a.Lo < b.Hi && b.Lo < a.Hi }

// Normalize returns the canonical form of ivs: invalid (empty) intervals
// dropped, remaining intervals sorted by Lo, and overlapping or adjacent
// intervals merged. The result contains no two intervals that touch.
func Normalize(ivs []Interval) []Interval {
	valid := make([]Interval, 0, len(ivs))
	for _, iv := range ivs {
		if iv.Valid() {
			valid = append(valid, iv)
		}
	}
	sort.Slice(valid, func(i, j int) bool {
		if valid[i].Lo != valid[j].Lo {
			return valid[i].Lo < valid[j].Lo
		}
		return valid[i].Hi < valid[j].Hi
	})
	out := valid[:0]
	for _, iv := range valid {
		if n := len(out); n > 0 && iv.Lo <= out[n-1].Hi {
			if iv.Hi > out[n-1].Hi {
				out[n-1].Hi = iv.Hi
			}
			continue
		}
		out = append(out, iv)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// prepare returns the evidence-preserving stored form of ivs: invalid
// intervals dropped, the rest sorted and deduplicated, but NOT merged.
// Adjacent or overlapping source intervals are kept distinct so that
// intersection queries can cite them as separate evidence.
func prepare(ivs []Interval) []Interval {
	var out []Interval
	for _, iv := range ivs {
		if iv.Valid() {
			out = append(out, iv)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Lo != out[j].Lo {
			return out[i].Lo < out[j].Lo
		}
		return out[i].Hi < out[j].Hi
	})
	n := 0
	for _, iv := range out {
		if n == 0 || out[n-1] != iv {
			out[n] = iv
			n++
		}
	}
	return out[:n]
}

// IsNormalized reports whether ivs is in canonical form: every interval
// valid, strictly increasing, and pairwise non-touching (prev.Hi < next.Lo).
func IsNormalized(ivs []Interval) bool {
	for i, iv := range ivs {
		if !iv.Valid() {
			return false
		}
		if i > 0 && ivs[i-1].Hi >= iv.Lo {
			return false
		}
	}
	return true
}
