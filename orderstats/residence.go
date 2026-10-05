package orderstats

import "time"

// overlap returns the length of [s, e) ∩ [start, end). A zero e is treated
// as unbounded, i.e. clipped by end.
func overlap(s, e, start, end time.Time) time.Duration {
	if s.Before(start) {
		s = start
	}
	if e.IsZero() || end.Before(e) {
		e = end
	}
	if !s.Before(e) {
		return 0
	}
	return e.Sub(s)
}

// Residence returns how long the order resided in each state within the
// half-open range [start, end). Residence is computed from half-open state
// intervals, so a transition at exactly start or end attributes the instant
// to the incoming state. An empty (or inverted) range yields an empty map.
func (t *Timeline) Residence(orderID string, start, end time.Time) map[State]time.Duration {
	res := make(map[State]time.Duration)
	if t.incr == nil || !start.Before(end) {
		return res
	}
	for _, iv := range t.incr.intervals[orderID] {
		if d := overlap(iv.Start, iv.End, start, end); d > 0 {
			res[iv.State] += d
		}
	}
	return res
}

// TotalResidence aggregates Residence over all known orders for the
// half-open range [start, end).
func (t *Timeline) TotalResidence(start, end time.Time) map[State]time.Duration {
	res := make(map[State]time.Duration)
	if t.incr == nil || !start.Before(end) {
		return res
	}
	for orderID := range t.incr.intervals {
		for state, d := range t.Residence(orderID, start, end) {
			res[state] += d
		}
	}
	return res
}
