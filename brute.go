package main

import "errors"

// solveBrute is a deliberately plain exhaustive enumeration over every
// (ship, berth, candidate start) combination with no pruning or search
// heuristics. It serves as an independent cross-check for solveExact on
// small instances.
func solveBrute(p Problem) (Solution, error) {
	n := len(p.Ships)
	feas := make([][]int, n)
	for i, s := range p.Ships {
		feas[i] = feasibleStarts(s)
	}
	occ := make([][]interval, len(p.Berths))
	assign := make([]Assignment, n)
	var best *Solution
	bestWait, bestEnd := 0, 0
	bestKey := ""

	var rec func(i, curWait, curEnd int)
	rec = func(i, curWait, curEnd int) {
		if i == n {
			key := solutionKey(assign)
			if best == nil || curWait < bestWait ||
				(curWait == bestWait && (curEnd < bestEnd || (curEnd == bestEnd && key < bestKey))) {
				cp := make([]Assignment, n)
				copy(cp, assign)
				best = &Solution{TotalWait: curWait, TotalEnd: curEnd, Assignments: cp}
				bestWait, bestEnd, bestKey = curWait, curEnd, key
			}
			return
		}
		s := p.Ships[i]
		for bi, b := range p.Berths {
			if b.Length < s.Length {
				continue
			}
			for _, st := range feas[i] {
				en := st + s.Duration
				if overlaps(occ[bi], st, en) {
					continue
				}
				occ[bi] = append(occ[bi], interval{st, en})
				assign[i] = Assignment{Ship: s.ID, Berth: b.ID, Start: st, End: en}
				rec(i+1, curWait+(st-s.Arrival), curEnd+en)
				occ[bi] = occ[bi][:len(occ[bi])-1]
			}
		}
	}
	rec(0, 0, 0)
	if best == nil {
		return Solution{}, errors.New("infeasible: no valid schedule exists")
	}
	return *best, nil
}
