package dataeng

import (
	"fmt"
	"time"
)

// Calendar generates half-open instant intervals aligned to calendar periods
// in a specific time zone.
//
// Contract: period boundaries are a pure function of the calendar
// configuration and the instant. They never depend on the queried range, so
// splitting a range, generating intervals per part and merging them back
// (see MergeAdjacent) always reproduces the intervals of the whole range.
type Calendar interface {
	// Intervals partitions [from, to) into consecutive half-open intervals
	// aligned to period boundaries in the calendar's time zone. The first
	// and last intervals are clipped to the query range; adjacent intervals
	// are seamless (each End equals the next Start). It returns nil when
	// from is not before to.
	Intervals(from, to time.Time) []Interval
	// IsBoundary reports whether t coincides with a period boundary.
	IsBoundary(t time.Time) bool
	// Label returns the name of the period that starts at the given
	// interval start (e.g. "2026-03-08", "2026-W10", "FY2025-M08",
	// "RY2023-P12").
	Label(start time.Time) string
}

// MergeSplit reassembles intervals produced by splitting a query range at
// arbitrary instants and generating intervals per sub-range. Consecutive
// intervals are merged exactly when their shared instant is not a calendar
// period boundary, i.e. when they are fragments of the same period. The
// result equals the intervals of the unsplit range. It returns
// ErrNotContiguous on gaps or overlaps.
func MergeSplit(c Calendar, ivs []Interval) ([]Interval, error) {
	if len(ivs) == 0 {
		return nil, nil
	}
	out := make([]Interval, 0, len(ivs))
	out = append(out, ivs[0])
	for _, iv := range ivs[1:] {
		last := &out[len(out)-1]
		switch {
		case iv.Start.Equal(last.End):
			if c.IsBoundary(iv.Start) {
				out = append(out, iv)
			} else {
				last.End = iv.End
			}
		case iv.Start.After(last.End):
			return nil, fmt.Errorf("%w: gap between %s and %s", ErrNotContiguous,
				last.End.Format(time.RFC3339), iv.Start.Format(time.RFC3339))
		default:
			return nil, fmt.Errorf("%w: overlap at %s", ErrNotContiguous,
				iv.Start.Format(time.RFC3339))
		}
	}
	return out, nil
}

// generator builds intervals from a floor/next pair of boundary functions.
// floor returns the greatest boundary <= t; next returns the least boundary
// strictly after b, where b is itself a boundary.
type generator struct {
	loc   *time.Location
	floor func(t time.Time) time.Time
	next  func(b time.Time) time.Time
}

func (g generator) intervals(from, to time.Time) []Interval {
	if !from.Before(to) {
		return nil
	}
	from = from.In(g.loc)
	to = to.In(g.loc)
	var out []Interval
	for b := g.floor(from); b.Before(to); {
		n := g.next(b)
		if !n.After(b) {
			panic("dataeng: calendar boundary function did not advance")
		}
		s := b
		if s.Before(from) {
			s = from
		}
		e := n
		if e.After(to) {
			e = to
		}
		out = append(out, Interval{Start: s, End: e})
		b = n
	}
	return out
}

func (g generator) isBoundary(t time.Time) bool {
	return g.floor(t.In(g.loc)).Equal(t)
}
