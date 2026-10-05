package setlib

import "sort"

// Contribution is one piece of source evidence: a single interval of the
// named set that overlaps a result interval.
type Contribution struct {
	SetID    string
	Interval Interval
}

// Result is one merged intersection interval together with the source
// evidence explaining which intervals of which sets produced it.
type Result struct {
	Interval Interval
	Evidence []Contribution
}

// Intersect computes the intersection of the given sets and returns merged
// (adjacent intervals coalesced) result intervals with per-set evidence.
// Each input slice is normalized internally, so callers may pass raw data.
func Intersect(sets map[string][]Interval) []Result {
	x := NewIntersector(0, 0)
	for id, ivs := range sets {
		x.sets[id] = prepare(ivs)
	}
	x.rebuildCounts()
	return x.Query()
}

// Intersector maintains a collection of named sets over a fixed integer
// domain [Lo, Hi) and answers intersection queries. Single-set corrections
// (Upsert/Remove) update internal coverage counts incrementally instead of
// recomputing from scratch. Sets are stored in evidence-preserving form
// (see prepare); coverage counts use their normalized form so that every
// point contributes at most one count per set.
type Intersector struct {
	Lo, Hi int
	sets   map[string][]Interval
	counts []int // counts[p-Lo] = number of sets covering point p
	dirty  bool
}

// NewIntersector returns an empty Intersector over the domain [lo, hi).
// A zero-size domain (lo >= hi) is allowed and derives its bounds from data.
func NewIntersector(lo, hi int) *Intersector {
	if hi < lo {
		hi = lo
	}
	return &Intersector{
		Lo:     lo,
		Hi:     hi,
		sets:   make(map[string][]Interval),
		counts: make([]int, hi-lo),
	}
}

// Upsert replaces the membership of a single set (a "member correction")
// and incrementally adjusts coverage counts by the symmetric difference.
func (x *Intersector) Upsert(id string, ivs []Interval) {
	if old, ok := x.sets[id]; ok {
		x.apply(Normalize(old), -1)
	}
	x.sets[id] = prepare(ivs)
	x.apply(Normalize(ivs), +1)
}

// Remove deletes a set and incrementally adjusts coverage counts.
func (x *Intersector) Remove(id string) {
	if old, ok := x.sets[id]; ok {
		x.apply(Normalize(old), -1)
		delete(x.sets, id)
	}
}

// Len returns the number of member sets.
func (x *Intersector) Len() int { return len(x.sets) }

// apply adds delta to the coverage count of every point in ivs.
func (x *Intersector) apply(ivs []Interval, delta int) {
	for _, iv := range ivs {
		lo, hi := iv.Lo, iv.Hi
		if lo < x.Lo {
			lo = x.Lo
		}
		if hi > x.Hi {
			hi = x.Hi
		}
		for p := lo; p < hi; p++ {
			x.counts[p-x.Lo] += delta
		}
	}
}

// rebuildCounts recomputes coverage from scratch (used by Intersect).
func (x *Intersector) rebuildCounts() {
	lo, hi := 0, 0
	first := true
	for _, ivs := range x.sets {
		for _, iv := range ivs {
			if first || iv.Lo < lo {
				lo = iv.Lo
			}
			if first || iv.Hi > hi {
				hi = iv.Hi
			}
			first = false
		}
	}
	if first {
		lo, hi = 0, 0
	}
	x.Lo, x.Hi = lo, hi
	x.counts = make([]int, hi-lo)
	for _, ivs := range x.sets {
		x.apply(Normalize(ivs), +1)
	}
}

// Query returns the merged intersection intervals with source evidence.
// Adjacent runs where every set is present are coalesced into one interval;
// the evidence lists, per set, the source intervals that overlap the run.
func (x *Intersector) Query() []Result {
	n := len(x.sets)
	if n == 0 {
		return nil
	}
	var runs []Interval
	for i, c := range x.counts {
		if c != n {
			continue
		}
		p := x.Lo + i
		if m := len(runs); m > 0 && runs[m-1].Hi == p {
			runs[m-1].Hi = p + 1
		} else {
			runs = append(runs, Interval{p, p + 1})
		}
	}
	out := make([]Result, len(runs))
	for i, run := range runs {
		out[i] = Result{Interval: run, Evidence: x.evidence(run)}
	}
	return out
}

// evidence collects, for every set, the source intervals overlapping run.
func (x *Intersector) evidence(run Interval) []Contribution {
	ids := make([]string, 0, len(x.sets))
	for id := range x.sets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var ev []Contribution
	for _, id := range ids {
		for _, iv := range x.sets[id] {
			if iv.Lo >= run.Hi {
				break
			}
			if Overlaps(iv, run) {
				ev = append(ev, Contribution{SetID: id, Interval: iv})
			}
		}
	}
	return ev
}
