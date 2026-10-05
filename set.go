// Package permset parses and evaluates permission-set expressions over
// int64 closed intervals. It supports union, intersection, difference,
// parentheses, named versioned definitions with cycle rejection, and
// per-segment provenance witnesses.
package permset

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// Interval is a closed interval [Lo, Hi] of int64 values.
type Interval struct {
	Lo, Hi int64
}

func (iv Interval) String() string {
	if iv.Lo == iv.Hi {
		return fmt.Sprintf("[%d]", iv.Lo)
	}
	return fmt.Sprintf("[%d,%d]", iv.Lo, iv.Hi)
}

// Set is a canonical set of int64 values: a sorted slice of disjoint,
// non-adjacent closed intervals.
type Set struct {
	ivs []Interval
}

// Intervals returns a copy of the canonical interval slice.
func (s Set) Intervals() []Interval {
	return slices.Clone(s.ivs)
}

// Empty reports whether the set contains no values.
func (s Set) Empty() bool { return len(s.ivs) == 0 }

// Norm builds a canonical Set from arbitrary intervals: sorted, disjoint,
// and with adjacent intervals merged. The adjacency check is guarded so
// that Hi+1 never overflows at math.MaxInt64.
func Norm(ivs []Interval) Set {
	sorted := slices.Clone(ivs)
	slices.SortFunc(sorted, func(a, b Interval) int {
		if a.Lo != b.Lo {
			return cmp64(a.Lo, b.Lo)
		}
		return cmp64(a.Hi, b.Hi)
	})
	out := sorted[:0]
	for _, iv := range sorted {
		if iv.Lo > iv.Hi {
			continue
		}
		if n := len(out); n > 0 {
			last := &out[n-1]
			// Overlapping or adjacent. When last.Hi == math.MaxInt64 the
			// first disjunct already covers every iv.Lo, so Hi+1 is never
			// evaluated at the overflow point.
			if iv.Lo <= last.Hi || (last.Hi < math.MaxInt64 && iv.Lo == last.Hi+1) {
				if iv.Hi > last.Hi {
					last.Hi = iv.Hi
				}
				continue
			}
		}
		out = append(out, iv)
	}
	return Set{ivs: out}
}

func cmp64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// Union returns the canonical union of two sets.
func (s Set) Union(o Set) Set {
	ivs := make([]Interval, 0, len(s.ivs)+len(o.ivs))
	ivs = append(ivs, s.ivs...)
	ivs = append(ivs, o.ivs...)
	return Norm(ivs)
}

// Intersect returns the canonical intersection of two canonical sets.
func (s Set) Intersect(o Set) Set {
	var out []Interval
	i, j := 0, 0
	for i < len(s.ivs) && j < len(o.ivs) {
		lo := max(s.ivs[i].Lo, o.ivs[j].Lo)
		hi := min(s.ivs[i].Hi, o.ivs[j].Hi)
		if lo <= hi {
			out = append(out, Interval{lo, hi})
		}
		if s.ivs[i].Hi < o.ivs[j].Hi {
			i++
		} else {
			j++
		}
	}
	// Outputs are subsets of disjoint, non-adjacent inputs, so they are
	// already canonical.
	return Set{ivs: out}
}

// Diff returns the canonical set difference s \ o. Endpoint arithmetic is
// guarded: b.Lo-1 is only computed when b.Lo > lo >= math.MinInt64, and
// b.Hi+1 is only computed when b.Hi < a.Hi <= math.MaxInt64, so removing
// an endpoint at math.MaxInt64 or math.MinInt64 cannot overflow.
func (s Set) Diff(o Set) Set {
	var out []Interval
	j := 0
	for _, a := range s.ivs {
		for j < len(o.ivs) && o.ivs[j].Hi < a.Lo {
			j++
		}
		lo := a.Lo
		done := false
		for k := j; k < len(o.ivs) && o.ivs[k].Lo <= a.Hi; k++ {
			b := o.ivs[k]
			if b.Hi < lo {
				continue
			}
			if b.Lo > lo {
				out = append(out, Interval{lo, b.Lo - 1})
			}
			if b.Hi >= a.Hi {
				done = true
				break
			}
			lo = b.Hi + 1
		}
		if !done {
			out = append(out, Interval{lo, a.Hi})
		}
	}
	return Set{ivs: out}
}

// Contains reports whether x is a member of the set.
func (s Set) Contains(x int64) bool {
	_, found := slices.BinarySearchFunc(s.ivs, x, func(iv Interval, x int64) int {
		switch {
		case x < iv.Lo:
			return 1
		case x > iv.Hi:
			return -1
		}
		return 0
	})
	return found
}

// Equal reports whether two sets contain exactly the same values.
func (s Set) Equal(o Set) bool {
	return slices.Equal(s.ivs, o.ivs)
}

func (s Set) String() string {
	if len(s.ivs) == 0 {
		return "{}"
	}
	parts := make([]string, len(s.ivs))
	for i, iv := range s.ivs {
		parts[i] = iv.String()
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
