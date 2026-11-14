package dataeng

import (
	"errors"
	"fmt"
	"time"
)

// Interval is a half-open range of instants [Start, End).
type Interval struct {
	Start time.Time
	End   time.Time
}

// Duration returns End.Sub(Start). Calendar periods that span a DST
// transition may therefore be shorter or longer than their nominal length
// (e.g. a 23h or 25h day).
func (iv Interval) Duration() time.Duration { return iv.End.Sub(iv.Start) }

// Contains reports whether t falls inside [Start, End).
func (iv Interval) Contains(t time.Time) bool {
	return !t.Before(iv.Start) && t.Before(iv.End)
}

func (iv Interval) String() string {
	return fmt.Sprintf("[%s, %s)", iv.Start.Format(time.RFC3339), iv.End.Format(time.RFC3339))
}

// ErrNotContiguous is returned when a sequence of intervals has a gap or an
// overlap where seamless adjacency was expected.
var ErrNotContiguous = errors.New("dataeng: intervals are not contiguous")

// MergeAdjacent coalesces consecutive intervals whose shared boundary is
// seamless (previous End equals next Start), preserving order. It returns
// ErrNotContiguous if two consecutive intervals overlap or leave a gap.
//
// Together with the Calendar contract (boundaries depend only on the
// calendar configuration and the instant, never on the queried range), this
// guarantees that splitting a query range at arbitrary instants, generating
// intervals per sub-range and merging them back yields exactly the intervals
// of the unsplit range.
func MergeAdjacent(ivs []Interval) ([]Interval, error) {
	if len(ivs) == 0 {
		return nil, nil
	}
	out := make([]Interval, 0, len(ivs))
	out = append(out, ivs[0])
	for _, iv := range ivs[1:] {
		last := &out[len(out)-1]
		switch {
		case iv.Start.Equal(last.End):
			last.End = iv.End
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

// Merge sorts intervals by start and coalesces any that overlap or touch.
// Unlike MergeAdjacent it tolerates unordered and overlapping input.
func Merge(ivs []Interval) []Interval {
	if len(ivs) == 0 {
		return nil
	}
	sorted := make([]Interval, len(ivs))
	copy(sorted, ivs)
	sortIntervals(sorted)
	out := make([]Interval, 0, len(sorted))
	cur := sorted[0]
	for _, iv := range sorted[1:] {
		if !iv.Start.After(cur.End) {
			if iv.End.After(cur.End) {
				cur.End = iv.End
			}
			continue
		}
		out = append(out, cur)
		cur = iv
	}
	return append(out, cur)
}

func sortIntervals(ivs []Interval) {
	for i := 1; i < len(ivs); i++ {
		for j := i; j > 0 && ivs[j].Start.Before(ivs[j-1].Start); j-- {
			ivs[j], ivs[j-1] = ivs[j-1], ivs[j]
		}
	}
}
