package frameidx

import "sort"

// SeekResult is the outcome of a Seek over a display-time interval.
type SeekResult struct {
	Targets     []int64      // frames whose PTS lies in the interval, sorted by (PTS, ID)
	Closure     []int64      // minimal dependency closure, sorted by (DTS, ID)
	MissingRefs []MissingRef // dangling references encountered inside the closure
	Cycle       []int64      // non-nil when the closure contains a dependency cycle
	Certificate *Certificate // topological decode-order certificate; nil when a cycle exists
}

// SeekInterval computes the minimal set of frames that must be decoded in order to
// display every frame whose PTS lies in [startPTS, endPTS]. The closure is
// exactly the target frames plus all transitively reachable references; no
// unrelated frame is included. Decode order is derived from the dependency
// graph and decode timestamps only — display time never implies decode order.
func (ix *Index) SeekInterval(startPTS, endPTS int64) *SeekResult {
	res := &SeekResult{}
	for _, id := range ix.order {
		if f := ix.frames[id]; f.PTS >= startPTS && f.PTS <= endPTS {
			res.Targets = append(res.Targets, id)
		}
	}
	sort.Slice(res.Targets, func(i, j int) bool {
		a, b := ix.frames[res.Targets[i]], ix.frames[res.Targets[j]]
		if a.PTS != b.PTS {
			return a.PTS < b.PTS
		}
		return a.ID < b.ID
	})
	if len(res.Targets) == 0 {
		res.Closure = []int64{}
		res.Certificate = &Certificate{Order: []int64{}}
		return res
	}

	// Minimal dependency closure: breadth-first walk over reference edges.
	inClosure := make(map[int64]bool, len(res.Targets))
	queue := make([]int64, 0, len(res.Targets))
	for _, t := range res.Targets {
		inClosure[t] = true
		queue = append(queue, t)
	}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, r := range ix.frames[id].Refs {
			if _, ok := ix.frames[r]; !ok {
				res.MissingRefs = append(res.MissingRefs, MissingRef{Frame: id, Ref: r})
				continue
			}
			if !inClosure[r] {
				inClosure[r] = true
				queue = append(queue, r)
			}
		}
	}
	closure := make([]int64, 0, len(inClosure))
	for id := range inClosure {
		closure = append(closure, id)
	}
	sort.Slice(closure, func(i, j int) bool {
		a, b := ix.frames[closure[i]], ix.frames[closure[j]]
		if a.DTS != b.DTS {
			return a.DTS < b.DTS
		}
		return a.ID < b.ID
	})
	res.Closure = closure

	if cyc := findCycles(ix, closure); len(cyc) > 0 {
		res.Cycle = cyc[0]
		return res
	}
	res.Certificate = ix.newCertificate(closure)
	return res
}
