package railplan

import "sort"

// EarliestShift finds the smallest whole-shift delta >= minDelta for the
// train: every reservation of the train is translated by the same delta,
// must stay inside the domain [0, MaxTime), and must not conflict with
// any other train. It returns false when no feasible shift exists.
//
// The search is interval-based: each conflicting reservation forbids a
// half-open range of deltas, and the answer is the first delta not
// covered by any forbidden range.
func (p *Planner) EarliestShift(train string, minDelta int) (int, bool) {
	own, ok := p.res[train]
	if !ok || len(own) == 0 {
		return 0, false
	}
	maxEnd := 0
	for _, r := range own {
		if r.Span.End > maxEnd {
			maxEnd = r.Span.End
		}
	}
	maxDelta := MaxTime - maxEnd
	if minDelta > maxDelta {
		return 0, false
	}

	var forbidden []Interval
	for _, r := range own {
		for id, rs := range p.res {
			if id == train {
				continue
			}
			for _, o := range rs {
				if o.Track != r.Track {
					continue
				}
				// Overlap iff o.Start - r.End < d < o.End - r.Start.
				lo := o.Span.Start - r.Span.End + 1
				hi := o.Span.End - r.Span.Start
				if lo < minDelta {
					lo = minDelta
				}
				if hi > maxDelta+1 {
					hi = maxDelta + 1
				}
				if lo < hi {
					forbidden = append(forbidden, Interval{Start: lo, End: hi})
				}
			}
		}
	}
	sort.Slice(forbidden, func(i, j int) bool {
		if forbidden[i].Start != forbidden[j].Start {
			return forbidden[i].Start < forbidden[j].Start
		}
		return forbidden[i].End < forbidden[j].End
	})

	d := minDelta
	for _, f := range forbidden {
		if f.Start > d {
			return d, true
		}
		if f.End > d {
			d = f.End
		}
	}
	if d <= maxDelta {
		return d, true
	}
	return 0, false
}

// earliestShiftBrute is the reference per-moment search used to verify
// EarliestShift: for every candidate delta it replays occupancy moment
// by moment on every track.
func (p *Planner) earliestShiftBrute(train string, minDelta int) (int, bool) {
	own, ok := p.res[train]
	if !ok || len(own) == 0 {
		return 0, false
	}
	maxEnd := 0
	for _, r := range own {
		if r.Span.End > maxEnd {
			maxEnd = r.Span.End
		}
	}
	for d := minDelta; d+maxEnd <= MaxTime; d++ {
		if p.shiftFeasibleByMoment(train, own, d) {
			return d, true
		}
	}
	return 0, false
}

// shiftFeasibleByMoment counts, for every moment in [0, MaxTime), how
// many trains occupy each track, and reports whether the shifted layout
// keeps every count at most one.
func (p *Planner) shiftFeasibleByMoment(train string, own []Reservation, delta int) bool {
	occ := map[string][]int{}
	at := func(track string) []int {
		a, ok := occ[track]
		if !ok {
			a = make([]int, MaxTime)
			occ[track] = a
		}
		return a
	}
	for id, rs := range p.res {
		if id == train {
			continue
		}
		for _, r := range rs {
			a := at(r.Track)
			for t := r.Span.Start; t < r.Span.End; t++ {
				a[t]++
			}
		}
	}
	for _, r := range own {
		a := at(r.Track)
		for t := r.Span.Start + delta; t < r.Span.End+delta; t++ {
			a[t]++
			if a[t] > 1 {
				return false
			}
		}
	}
	return true
}
