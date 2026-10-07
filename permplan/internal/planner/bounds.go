package planner

// Bounds brackets the optimum: Lower is a provable lower bound, Upper
// the cost of a greedily constructed feasible plan (UpperOK false when
// the greedy search found none).
type Bounds struct {
	Lower   int64 `json:"lower"`
	Upper   int64 `json:"upper"`
	UpperOK bool  `json:"upper_ok"`
}

// ComputeBounds derives a relaxation lower bound and a greedy upper
// bound for the instance.
func ComputeBounds(in *Input) Bounds {
	inst := prepare(in)
	var b Bounds
	if inst.total == 0 {
		return Bounds{Lower: 0, Upper: 0, UpperOK: true}
	}
	// Lower bound: relax fixed costs to the cheapest selectable rule and
	// price every demanded unit at the cheapest use cost covering it.
	if len(inst.rules) > 0 {
		minFixed := inst.rules[0].Cost
		for _, r := range inst.rules {
			if r.Cost < minFixed {
				minFixed = r.Cost
			}
		}
		b.Lower = minFixed
	}
	for j, a := range inst.actions {
		best := int64(-1)
		for _, r := range inst.rules {
			if r.Actions[a] > 0 && (best < 0 || r.UseCost < best) {
				best = r.UseCost
			}
		}
		if best < 0 {
			b.Lower = noSolution // some action uncoverable: infeasible
			return b
		}
		b.Lower += best * int64(inst.demand[j])
	}
	// Upper bound: greedy set multi-cover, then exact assignment.
	if mask, ok := inst.greedyMask(); ok {
		if s := inst.solutionFor(mask); s != nil {
			b.Upper = s.Cost
			b.UpperOK = true
		}
	}
	return b
}

// greedyMask grows a feasible selection by repeatedly adding the rule
// with the best newly-covered-units per fixed cost, pulling in
// prerequisites and skipping mutex conflicts.
func (inst *instance) greedyMask() (uint32, bool) {
	var mask uint32
	uncovered := make([]int, len(inst.actions))
	copy(uncovered, inst.demand)
	left := inst.total
	for left > 0 {
		bestGain := int64(0)
		bestMask := uint32(0)
		bestCost := int64(0)
		found := false
		for i := range inst.rules {
			bit := uint32(1) << uint(i)
			if mask&bit != 0 || inst.mutexMask[i]&mask != 0 {
				continue
			}
			add := bit | inst.prereqClosure(i)
			if add&^mask == 0 {
				continue
			}
			if !inst.maskValid(mask | add) {
				continue
			}
			gain := int64(0)
			for j, a := range inst.actions {
				g := inst.rules[i].Actions[a]
				if g > uncovered[j] {
					g = uncovered[j]
				}
				gain += int64(g)
			}
			if gain <= 0 {
				continue
			}
			cost := inst.rules[i].Cost + 1
			// maximize gain/cost, then smaller gain cost, then lower index
			if !found || gain*bestCost > bestGain*cost ||
				(gain*bestCost == bestGain*cost && cost < bestCost) {
				found = true
				bestGain, bestCost, bestMask = gain, cost, add
			}
		}
		if !found {
			return 0, false
		}
		mask |= bestMask
		// Recompute uncovered against the whole selection (approximate:
		// subtract per-action limits of newly added rules).
		for i := range inst.rules {
			if bestMask&(1<<uint(i)) == 0 {
				continue
			}
			for j, a := range inst.actions {
				g := inst.rules[i].Actions[a]
				if g > uncovered[j] {
					g = uncovered[j]
				}
				uncovered[j] -= g
				left -= g
			}
		}
		if left < 0 {
			left = 0
		}
	}
	if !inst.coverPossible(mask, make([]int, len(inst.actions))) {
		return 0, false
	}
	return mask, true
}

// prereqClosure returns the bitmask of all transitive prerequisites of
// rule i (excluding i itself).
func (inst *instance) prereqClosure(i int) uint32 {
	var closure uint32
	stack := []int{i}
	seen := map[int]bool{i: true}
	for len(stack) > 0 {
		u := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		m := inst.prereqMask[u]
		for v := 0; v < len(inst.rules); v++ {
			if m&(1<<uint(v)) != 0 && !seen[v] {
				seen[v] = true
				closure |= 1 << uint(v)
				stack = append(stack, v)
			}
		}
	}
	return closure
}
