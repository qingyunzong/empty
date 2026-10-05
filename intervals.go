package seglib

import "sort"

// interval is a half-open range [start, end).
type interval struct {
	start, end uint64
}

// intervalSet keeps a sorted list of disjoint, non-adjacent intervals.
type intervalSet struct {
	ivs []interval
}

// add merges [start, end) into the set, coalescing overlapping or
// adjacent intervals.
func (s *intervalSet) add(start, end uint64) {
	if end <= start {
		return
	}
	ivs := s.ivs
	i := sort.Search(len(ivs), func(i int) bool { return ivs[i].end >= start })
	j := sort.Search(len(ivs), func(j int) bool { return ivs[j].start > end })
	if i < len(ivs) && ivs[i].start < start {
		start = ivs[i].start
	}
	if j > 0 && ivs[j-1].end > end {
		end = ivs[j-1].end
	}
	merged := make([]interval, 0, len(ivs)-(j-i)+1)
	merged = append(merged, ivs[:i]...)
	merged = append(merged, interval{start, end})
	merged = append(merged, ivs[j:]...)
	s.ivs = merged
}

// contiguousPrefix returns the largest p such that every offset in
// [from, p) is covered by the set. Out-of-order additions beyond a gap
// do not move the prefix.
func (s *intervalSet) contiguousPrefix(from uint64) uint64 {
	p := from
	for {
		i := sort.Search(len(s.ivs), func(i int) bool { return s.ivs[i].end > p })
		if i < len(s.ivs) && s.ivs[i].start <= p {
			p = s.ivs[i].end
			continue
		}
		return p
	}
}
