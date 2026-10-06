package occupancy

import "sort"

// maxDeltaFor clamps maxDelta so that no shifted interval leaves [0, MaxTime).
func maxDeltaFor(res []Reservation, maxDelta int) int {
	for _, r := range res {
		if d := MaxTime - r.End; d < maxDelta {
			maxDelta = d
		}
	}
	return maxDelta
}

// EarliestShift returns the smallest delta in [minDelta, maxDelta] such that
// shifting every reservation of the train by delta keeps it inside the time
// domain and free of conflicts with other trains. The train's own old
// reservations are excluded from the check.
//
// It works by sweeping the union of forbidden delta ranges instead of
// testing each delta: a reservation [s,e) conflicts with another train's
// reservation [s2,e2) on the same track exactly for integer deltas in
// [s2-e+1, e2-s-1].
func (p *Planner) EarliestShift(id string, minDelta, maxDelta int) (int, bool) {
	res, ok := p.trains[id]
	if !ok {
		return 0, false
	}
	maxDelta = maxDeltaFor(res, maxDelta)
	if minDelta < 0 {
		minDelta = 0
	}
	if minDelta > maxDelta {
		return 0, false
	}
	type event struct {
		at    int
		delta int
	}
	var events []event
	for _, a := range res {
		for otherID, other := range p.trains {
			if otherID == id {
				continue
			}
			for _, b := range other {
				if a.Track != b.Track {
					continue
				}
				lo := b.Start - a.End + 1
				hi := b.End - a.Start - 1
				if lo < minDelta {
					lo = minDelta
				}
				if hi > maxDelta {
					hi = maxDelta
				}
				if lo > hi {
					continue
				}
				events = append(events, event{lo, 1}, event{hi + 1, -1})
			}
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].at < events[j].at })
	blocked := 0
	pos := minDelta
	i := 0
	for i < len(events) {
		at := events[i].at
		if blocked == 0 && pos < at {
			return pos, true
		}
		for i < len(events) && events[i].at == at {
			blocked += events[i].delta
			i++
		}
		pos = at
	}
	if blocked == 0 && pos <= maxDelta {
		return pos, true
	}
	return 0, false
}

// EarliestShiftBrute is the reference per-delta search used to verify
// EarliestShift: it tests every delta minDelta, minDelta+1, ... by direct
// overlap checks.
func (p *Planner) EarliestShiftBrute(id string, minDelta, maxDelta int) (int, bool) {
	res, ok := p.trains[id]
	if !ok {
		return 0, false
	}
	maxDelta = maxDeltaFor(res, maxDelta)
	if minDelta < 0 {
		minDelta = 0
	}
	for d := minDelta; d <= maxDelta; d++ {
		if !p.conflictsWithOthers(id, Shifted(res, d)) {
			return d, true
		}
	}
	return 0, false
}
