// Package permset parses and evaluates permission-set expressions over
// closed intervals of 64-bit integers. It supports union (|), intersection
// (&), difference (-), parentheses, and versioned named-set definitions.
package permset

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// Interval is a closed integer interval [Lo, Hi] with Lo <= Hi.
type Interval struct {
	Lo, Hi int64
}

// Contains reports whether v lies in the interval.
func (iv Interval) Contains(v int64) bool { return v >= iv.Lo && v <= iv.Hi }

// Segment is an interval annotated with the sorted, de-duplicated set of
// source-expression witnesses (named-set references and interval literals)
// that produced it.
type Segment struct {
	Interval
	Sources []string
}

// absorbable reports whether b can be merged into a (a sorts before b),
// i.e. they overlap or are adjacent. The check is overflow-safe: when
// a.Hi == math.MaxInt64 every later interval is absorbed, and a.Hi+1 is
// never evaluated on the overflow path.
func absorbable(a, b Interval) bool {
	if a.Hi == math.MaxInt64 {
		return true
	}
	return a.Hi+1 >= b.Lo
}

// Normalize sorts intervals and merges overlapping or adjacent ones into a
// canonical list of disjoint closed intervals. Empty intervals (Lo > Hi)
// are dropped. Adjacency merging is safe at math.MaxInt64.
func Normalize(ivs []Interval) []Interval {
	var out []Interval
	sorted := slices.Clone(ivs)
	slices.SortFunc(sorted, func(x, y Interval) int {
		if x.Lo != y.Lo {
			return compareInt64(x.Lo, y.Lo)
		}
		return compareInt64(x.Hi, y.Hi)
	})
	for _, iv := range sorted {
		if iv.Lo > iv.Hi {
			continue
		}
		if n := len(out); n > 0 && absorbable(out[n-1], iv) {
			if iv.Hi > out[n-1].Hi {
				out[n-1].Hi = iv.Hi
			}
			continue
		}
		out = append(out, iv)
	}
	return out
}

func compareInt64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// Canonical flattens segments into canonical disjoint closed intervals,
// merging adjacent segments regardless of their provenance.
func Canonical(segs []Segment) []Interval {
	var out []Interval
	for _, s := range segs {
		if n := len(out); n > 0 && absorbable(out[n-1], s.Interval) {
			if s.Interval.Hi > out[n-1].Hi {
				out[n-1].Hi = s.Interval.Hi
			}
			continue
		}
		out = append(out, s.Interval)
	}
	return out
}

// Format renders canonical intervals as "[a,b] | [c,d]".
func Format(ivs []Interval) string {
	parts := make([]string, len(ivs))
	for i, iv := range ivs {
		parts[i] = fmt.Sprintf("[%d,%d]", iv.Lo, iv.Hi)
	}
	return strings.Join(parts, " | ")
}

// Union returns the canonical union of two interval lists.
func Union(a, b []Interval) []Interval {
	return Canonical(combine(bare(Normalize(a)), bare(Normalize(b)), opUnion))
}

// Intersect returns the canonical intersection of two interval lists.
func Intersect(a, b []Interval) []Interval {
	return Canonical(combine(bare(Normalize(a)), bare(Normalize(b)), opInter))
}

// Subtract returns the canonical difference a \ b. Endpoint removal is
// overflow-safe at math.MinInt64 and math.MaxInt64.
func Subtract(a, b []Interval) []Interval {
	return Canonical(combine(bare(Normalize(a)), bare(Normalize(b)), opSub))
}

func bare(ivs []Interval) []Segment {
	segs := make([]Segment, len(ivs))
	for i, iv := range ivs {
		segs[i] = Segment{Interval: iv}
	}
	return segs
}

type segOp int

const (
	opUnion segOp = iota
	opInter
	opSub
)

// mergeSources merges two sorted, de-duplicated source lists.
func mergeSources(a, b []string) []string {
	out := make([]string, 0, len(a)+len(b))
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			out = append(out, a[i])
			i++
			j++
		case a[i] < b[j]:
			out = append(out, a[i])
			i++
		default:
			out = append(out, b[j])
			j++
		}
	}
	out = append(out, a[i:]...)
	out = append(out, b[j:]...)
	return out
}

// addSource returns a copy of srcs with name inserted (sorted, unique).
func addSource(srcs []string, name string) []string {
	out := make([]string, 0, len(srcs)+1)
	inserted := false
	for _, s := range srcs {
		if !inserted {
			switch {
			case s == name:
				inserted = true
			case s > name:
				out = append(out, name)
				inserted = true
			}
		}
		out = append(out, s)
	}
	if !inserted {
		out = append(out, name)
	}
	return out
}

// appendSegment appends s to out, merging into the last segment when they
// are adjacent (or overlapping) and carry identical provenance. The merge
// is overflow-safe at math.MaxInt64.
func appendSegment(out []Segment, s Segment) []Segment {
	if n := len(out); n > 0 {
		last := &out[n-1]
		if slices.Equal(last.Sources, s.Sources) && absorbable(last.Interval, s.Interval) {
			if s.Interval.Hi > last.Interval.Hi {
				last.Interval.Hi = s.Interval.Hi
			}
			return out
		}
	}
	return append(out, s)
}

// combine sweeps two sorted, disjoint segment lists and applies op.
// Provenance rules: union keeps sources of whichever side covers a point,
// intersection unions both sides' sources, difference keeps the left
// side's sources. Adjacent output segments with identical sources merge.
func combine(a, b []Segment, op segOp) []Segment {
	var out []Segment
	i, j := 0, 0
	if len(a) == 0 && len(b) == 0 {
		return nil
	}
	lo := int64(math.MaxInt64)
	if len(a) > 0 {
		lo = a[0].Interval.Lo
	}
	if len(b) > 0 && b[0].Interval.Lo < lo {
		lo = b[0].Interval.Lo
	}
	for {
		for i < len(a) && a[i].Interval.Hi < lo {
			i++
		}
		for j < len(b) && b[j].Interval.Hi < lo {
			j++
		}
		inA := i < len(a) && a[i].Interval.Lo <= lo
		inB := j < len(b) && b[j].Interval.Lo <= lo
		if !inA && !inB {
			// Gap: jump to the next covered point, if any.
			switch {
			case i < len(a) && j < len(b):
				lo = a[i].Interval.Lo
				if b[j].Interval.Lo < lo {
					lo = b[j].Interval.Lo
				}
			case i < len(a):
				lo = a[i].Interval.Lo
			case j < len(b):
				lo = b[j].Interval.Lo
			default:
				return out
			}
			continue
		}
		hi := int64(math.MaxInt64)
		if inA {
			hi = a[i].Interval.Hi
		}
		if inB && b[j].Interval.Hi < hi {
			hi = b[j].Interval.Hi
		}
		// Clamp the span where the other side starts mid-interval so
		// provenance (and difference) boundaries stay exact. The start
		// is > lo here, so Lo-1 cannot underflow.
		if !inB && j < len(b) && b[j].Interval.Lo <= hi {
			hi = b[j].Interval.Lo - 1
		}
		if !inA && i < len(a) && a[i].Interval.Lo <= hi {
			hi = a[i].Interval.Lo - 1
		}
		var sa, sb []string
		if inA {
			sa = a[i].Sources
		}
		if inB {
			sb = b[j].Sources
		}
		emit := false
		var src []string
		switch op {
		case opUnion:
			if inA || inB {
				emit = true
				src = mergeSources(sa, sb)
			}
		case opInter:
			if inA && inB {
				emit = true
				src = mergeSources(sa, sb)
			}
		case opSub:
			if inA && !inB {
				emit = true
				src = sa
			}
		}
		if emit {
			out = appendSegment(out, Segment{Interval: Interval{Lo: lo, Hi: hi}, Sources: src})
		}
		if hi == math.MaxInt64 {
			break
		}
		lo = hi + 1
	}
	return out
}
