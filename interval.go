package dataeng

import "sort"

// Interval is a half-open range [Start, End) of zero-based row positions.
type Interval struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

// Len returns the number of rows covered by the interval.
func (i Interval) Len() int64 {
	if i.End <= i.Start {
		return 0
	}
	return i.End - i.Start
}

// Contains reports whether pos is inside the half-open interval.
func (i Interval) Contains(pos int64) bool {
	return pos >= i.Start && pos < i.End
}

func coalescePositions(positions []int64) []Interval {
	if len(positions) == 0 {
		return nil
	}
	sort.Slice(positions, func(i, j int) bool { return positions[i] < positions[j] })

	intervals := make([]Interval, 0, len(positions))
	start, end := positions[0], positions[0]+1
	for _, pos := range positions[1:] {
		if pos == end {
			end++
			continue
		}
		if pos < end {
			continue
		}
		intervals = append(intervals, Interval{Start: start, End: end})
		start, end = pos, pos+1
	}
	intervals = append(intervals, Interval{Start: start, End: end})
	return intervals
}

func covers(intervals []Interval, pos int64) bool {
	idx := sort.Search(len(intervals), func(i int) bool {
		return intervals[i].End > pos
	})
	return idx < len(intervals) && intervals[idx].Start <= pos
}
