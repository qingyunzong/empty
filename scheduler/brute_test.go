package scheduler

// bruteForce enumerates every constraint-satisfying schedule and returns
// the one with minimum cost, ties broken by the lexicographically
// smallest pair sequence. It is the reference oracle for the DP solver
// on short sequences.
func bruteForce(p Problem) (Schedule, bool) {
	pairs := make([][]Pair, p.NumSlots)
	for slot := range pairs {
		pairs[slot] = qualifiedPairs(p, slot)
	}

	var best Schedule
	bestCost := 0
	found := false
	runs := make([]int, p.NumPeople)
	sched := make(Schedule, 0, p.NumSlots)

	var rec func(slot, cost int)
	rec = func(slot, cost int) {
		if slot == p.NumSlots {
			if !found || cost < bestCost || (cost == bestCost && lexLess(sched, best)) {
				found = true
				bestCost = cost
				best = append(Schedule(nil), sched...)
			}
			return
		}
		for _, pr := range pairs[slot] {
			if slot > 0 && !sharesPerson(sched[slot-1], pr) {
				continue
			}
			saved := append([]int(nil), runs...)
			ok := true
			for person := range runs {
				if contains(pr, person) {
					runs[person]++
					if runs[person] > MaxConsec {
						ok = false
					}
				} else {
					runs[person] = 0
				}
			}
			if ok {
				sched = append(sched, pr)
				rec(slot+1, cost+p.Cost[pr[0]][slot]+p.Cost[pr[1]][slot])
				sched = sched[:len(sched)-1]
			}
			copy(runs, saved)
		}
	}
	rec(0, 0)
	return best, found
}
