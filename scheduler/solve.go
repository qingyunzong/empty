package scheduler

// state is the DP frontier after fixing the pair of one slot: the pair
// itself plus the current consecutive-run length of each of its members.
// People outside the pair have run length zero, so this state fully
// captures everything the constraints depend on.
type state struct {
	pair Pair
	run0 int
	run1 int
}

// candidate is a partial schedule ending in a given state.
type candidate struct {
	cost  int
	sched Schedule
}

// better reports whether a beats b: lower cost first, then the
// lexicographically smaller pair sequence.
func better(a, b candidate) bool {
	if a.cost != b.cost {
		return a.cost < b.cost
	}
	return lexLess(a.sched, b.sched)
}

// qualifiedPairs lists every unordered pair of people qualified for slot.
func qualifiedPairs(p Problem, slot int) []Pair {
	var pairs []Pair
	for a := 0; a < p.NumPeople; a++ {
		if !p.Qualified[a][slot] {
			continue
		}
		for b := a + 1; b < p.NumPeople; b++ {
			if p.Qualified[b][slot] {
				pairs = append(pairs, Pair{a, b})
			}
		}
	}
	return pairs
}

// Solve finds a feasible schedule minimizing total preference cost, with
// ties broken by the lexicographically smallest sequence of pairs. The
// second result reports whether any feasible schedule exists.
func Solve(p Problem) (Schedule, bool) {
	if err := p.Validate(); err != nil {
		return nil, false
	}

	current := make(map[state]candidate)
	for _, pr := range qualifiedPairs(p, 0) {
		cand := candidate{
			cost:  p.Cost[pr[0]][0] + p.Cost[pr[1]][0],
			sched: Schedule{pr},
		}
		st := state{pair: pr, run0: 1, run1: 1}
		if old, ok := current[st]; !ok || better(cand, old) {
			current[st] = cand
		}
	}

	for slot := 1; slot < p.NumSlots; slot++ {
		pairs := qualifiedPairs(p, slot)
		next := make(map[state]candidate)
		for st, cand := range current {
			for _, pr := range pairs {
				if !sharesPerson(st.pair, pr) {
					continue
				}
				run0 := nextRun(st, pr[0])
				run1 := nextRun(st, pr[1])
				if run0 > MaxConsec || run1 > MaxConsec {
					continue
				}
				sched := make(Schedule, len(cand.sched)+1)
				copy(sched, cand.sched)
				sched[len(cand.sched)] = pr
				nextCand := candidate{
					cost:  cand.cost + p.Cost[pr[0]][slot] + p.Cost[pr[1]][slot],
					sched: sched,
				}
				nextState := state{pair: pr, run0: run0, run1: run1}
				if old, ok := next[nextState]; !ok || better(nextCand, old) {
					next[nextState] = nextCand
				}
			}
		}
		current = next
		if len(current) == 0 {
			return nil, false
		}
	}

	var best candidate
	first := true
	for _, cand := range current {
		if first || better(cand, best) {
			best = cand
			first = false
		}
	}
	if first {
		return nil, false
	}
	return best.sched, true
}

// nextRun returns the consecutive-run length person would have after
// working the slot following st.
func nextRun(st state, person int) int {
	switch person {
	case st.pair[0]:
		return st.run0 + 1
	case st.pair[1]:
		return st.run1 + 1
	default:
		return 1
	}
}
