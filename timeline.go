package orderstats

import "time"

// Segment is a half-open residence interval [Start, End) in one state.
// A zero End means the segment is open-ended (the current state).
type Segment struct {
	State State
	Start time.Time
	End   time.Time
}

// Contains reports whether t lies in the half-open interval [Start, End).
func (s Segment) Contains(t time.Time) bool {
	if t.Before(s.Start) {
		return false
	}
	return s.End.IsZero() || t.Before(s.End)
}

// Residency sums, per state, how long the timeline resided inside the
// half-open query interval [from, to). An empty or inverted interval
// yields no residency.
func Residency(tl []Segment, from, to time.Time) map[State]time.Duration {
	out := map[State]time.Duration{}
	if !from.Before(to) {
		return out
	}
	for _, s := range tl {
		start := s.Start
		if start.Before(from) {
			start = from
		}
		end := s.End
		if end.IsZero() || end.After(to) {
			end = to
		}
		if end.After(start) {
			out[s.State] += end.Sub(start)
		}
	}
	return out
}
