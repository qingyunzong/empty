package dataeng

import (
	"errors"
	"sort"
)

// ErrInfeasible is returned when no selection of non-overlapping candidate
// intervals covers every required anchor exactly once.
var ErrInfeasible = errors.New("dataeng: no feasible partition covers all required anchors")

// Candidate is a non-empty, half-open node-index interval [Start, End) with a
// non-negative profit. Its node indices index the ordered node feature slice
// supplied to BestPartition.
type Candidate struct {
	Start  int
	End    int
	Profit int64
}

// Interval is one selected segment of an optimal partition.
type Interval struct {
	Start int
	End   int
}

// Partition is an optimal selection of candidate intervals.
type Partition struct {
	// Intervals are the chosen candidate intervals in document order
	// (ascending Start, and because they never overlap, also ascending End).
	Intervals []Interval
	// Records is the number of selected intervals.
	Records int
	// Profit is the sum of the selected candidates' profits.
	Profit int64
}

type candidate struct {
	start  int
	end    int
	profit int64
	orig   int
}

type state struct {
	reachable bool
	profit    int64
	count     int
	path      []int // original candidate indices, ordered by (start, end)
}

// BestPartition chooses non-overlapping (touching is allowed) candidate
// intervals so that total profit is maximized and every anchor node falls in
// exactly one chosen interval. Nodes holds the node feature strings in
// document order; candidates and anchors reference its indices.
//
// Tie-breaking, in order: maximum total profit, then fewest selected records,
// then lexicographically smallest list of (start, end) pairs in document
// order. The anchor constraints are enforced inside the dynamic program; the
// unconstrained interval-scheduling optimum is never computed and filtered.
func BestPartition(nodes []string, candidates []Candidate, anchors []int) (*Partition, error) {
	if err := validate(len(nodes), candidates, anchors); err != nil {
		return nil, err
	}

	sortedAnchors := append([]int(nil), anchors...)
	sort.Ints(sortedAnchors)

	cands := make([]candidate, len(candidates))
	for index, cand := range candidates {
		cands[index] = candidate{
			start:  cand.Start,
			end:    cand.End,
			profit: cand.Profit,
			orig:   index,
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].end != cands[j].end {
			return cands[i].end < cands[j].end
		}
		if cands[i].start != cands[j].start {
			return cands[i].start < cands[j].start
		}
		return cands[i].orig < cands[j].orig
	})

	// anchorsIn returns the number of sorted anchors in [lo, hi).
	anchorsIn := func(lo, hi int) int {
		first := sort.SearchInts(sortedAnchors, lo)
		last := sort.SearchInts(sortedAnchors, hi)
		return last - first
	}

	// dp[k] is the best feasible partial partition whose last selected
	// candidate is cands[k]. Feasibility means no anchor before cands[k].end
	// is left uncovered and no anchor is covered twice (no overlap).
	dp := make([]state, len(cands))
	for k, cand := range cands {
		best := state{
			reachable: true,
			profit:    cand.profit,
			count:     1,
			path:      []int{cand.orig},
		}

		// Start the partition with cand only if no anchor precedes it.
		if anchorsIn(0, cand.start) != 0 {
			best.reachable = false
		}

		for prev := 0; prev < k; prev++ {
			prevState := dp[prev]
			if !prevState.reachable {
				continue
			}
			prevCand := cands[prev]
			if prevCand.end > cand.start {
				continue // overlapping intervals cannot both be selected
			}
			// An anchor in the gap between the two intervals would never be
			// covered, so the transition is invalid.
			if anchorsIn(prevCand.end, cand.start) != 0 {
				continue
			}
			candidateState := state{
				reachable: true,
				profit:    prevState.profit + cand.profit,
				count:     prevState.count + 1,
				path:      append(append([]int(nil), prevState.path...), cand.orig),
			}
			if !best.reachable || better(candidateState, best, candidates) {
				best = candidateState
			}
		}

		dp[k] = best
	}

	// Empty selection is optimal only when no anchor has to be covered.
	var answer state
	if len(sortedAnchors) == 0 {
		answer = state{reachable: true, path: []int{}}
	}
	for k, cand := range cands {
		current := dp[k]
		if !current.reachable {
			continue
		}
		// Anchors at or after the last interval's end remain uncovered.
		if anchorsIn(cand.end, len(nodes)) != 0 {
			continue
		}
		if !answer.reachable || better(current, answer, candidates) {
			answer = current
		}
	}

	if !answer.reachable {
		return nil, ErrInfeasible
	}

	intervals := make([]Interval, 0, len(answer.path))
	for _, orig := range answer.path {
		intervals = append(intervals, Interval{Start: candidates[orig].Start, End: candidates[orig].End})
	}
	return &Partition{
		Intervals: intervals,
		Records:   answer.count,
		Profit:    answer.profit,
	}, nil
}

// better reports whether a is preferred to b under the tie-breaking rules:
// more profit, then fewer records, then the smaller span list lexicographically.
// State paths store input candidate indices, so candidates (in input order)
// resolves every span directly.
func better(a, b state, candidates []Candidate) bool {
	if a.profit != b.profit {
		return a.profit > b.profit
	}
	if a.count != b.count {
		return a.count < b.count
	}
	for i := 0; i < a.count; i++ {
		left := candidates[a.path[i]]
		right := candidates[b.path[i]]
		if left.Start != right.Start {
			return left.Start < right.Start
		}
		if left.End != right.End {
			return left.End < right.End
		}
	}
	// Equal-count paths compared element by element are identical here.
	return false
}

func validate(nodeCount int, candidates []Candidate, anchors []int) error {
	if nodeCount < 0 {
		return errors.New("dataeng: negative node count")
	}

	for _, cand := range candidates {
		if cand.Start < 0 || cand.End <= cand.Start || cand.End > nodeCount {
			return errors.New("dataeng: candidate interval is not a non-empty half-open node-index interval")
		}
		if cand.Profit < 0 {
			return errors.New("dataeng: candidate profit must be non-negative")
		}
	}

	seen := make(map[int]bool, len(anchors))
	for _, anchor := range anchors {
		if anchor < 0 || anchor >= nodeCount {
			return errors.New("dataeng: anchor node index out of range")
		}
		if seen[anchor] {
			return errors.New("dataeng: anchor list contains duplicates")
		}
		seen[anchor] = true
	}
	return nil
}
