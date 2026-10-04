package seglog

import "sort"

// interval is a half-open range [lo, hi) of segment indices.
type interval struct {
	lo, hi int
}

// intervalSet keeps a sorted, disjoint, non-adjacent list of intervals.
type intervalSet struct {
	ivs []interval
}

// add records a single segment index, merging overlapping or adjacent
// intervals so the set stays canonical.
func (s *intervalSet) add(id int) {
	lo, hi := id, id+1
	i := 0
	for i < len(s.ivs) && s.ivs[i].hi < lo {
		i++
	}
	j := i
	for j < len(s.ivs) && s.ivs[j].lo <= hi {
		if s.ivs[j].lo < lo {
			lo = s.ivs[j].lo
		}
		if s.ivs[j].hi > hi {
			hi = s.ivs[j].hi
		}
		j++
	}
	merged := make([]interval, 0, len(s.ivs)-(j-i)+1)
	merged = append(merged, s.ivs[:i]...)
	merged = append(merged, interval{lo, hi})
	merged = append(merged, s.ivs[j:]...)
	s.ivs = merged
}

// contains reports whether id is inside any recorded interval.
func (s *intervalSet) contains(id int) bool {
	i := sort.Search(len(s.ivs), func(i int) bool { return s.ivs[i].hi > id })
	return i < len(s.ivs) && s.ivs[i].lo <= id
}

// prefix returns the length of the contiguous run of recorded indices
// starting at base. Indices below base are treated as already covered.
func (s *intervalSet) prefix(base int) int {
	p := base
	for _, iv := range s.ivs {
		if iv.lo > p {
			break
		}
		if iv.hi > p {
			p = iv.hi
		}
	}
	return p
}

// dropBelow discards all coverage strictly below n, clipping any
// interval that straddles n.
func (s *intervalSet) dropBelow(n int) {
	i := 0
	for i < len(s.ivs) && s.ivs[i].hi <= n {
		i++
	}
	s.ivs = s.ivs[i:]
	if len(s.ivs) > 0 && s.ivs[0].lo < n {
		s.ivs[0].lo = n
	}
}
