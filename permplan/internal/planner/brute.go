package planner

import "sort"

// This file holds an intentionally independent, dead-simple brute force
// used only to cross-check the real solver on small instances:
//   - BruteForce enumerates every rule subset and every unit-by-unit
//     assignment of the demand multiset (small-assignment enumeration).
// It shares no code with the flow-based solver.

// BruteForce returns the minimum achievable total cost and one optimal
// selection (nil when infeasible). It is exponential in both the number
// of rules and the total demand; use only on small instances.
func BruteForce(in *Input) (int64, []string) {
	inst := prepare(in)
	if inst.total == 0 {
		return 0, nil
	}
	n := len(inst.rules)
	best := noSolution
	var bestSel []string
	for mask := uint32(1); mask < (uint32(1) << uint(n)); mask++ {
		if !inst.maskValid(mask) || !inst.coverPossible(mask, make([]int, len(inst.actions))) {
			continue
		}
		var fixed int64
		var sel []int
		for i := range inst.rules {
			if mask&(1<<uint(i)) != 0 {
				fixed += inst.rules[i].Cost
				sel = append(sel, i)
			}
		}
		if fixed >= best {
			continue
		}
		useCost, ok := inst.bruteAssign(sel)
		if !ok {
			continue
		}
		total := fixed + useCost
		if total < best {
			best = total
			bestSel = bestSel[:0]
			for _, i := range sel {
				bestSel = append(bestSel, inst.rules[i].ID)
			}
		}
	}
	if best == noSolution {
		return noSolution, nil
	}
	sort.Strings(bestSel)
	return best, bestSel
}

// bruteAssign enumerates every assignment of demanded units to the
// selected rules, one unit at a time, respecting per-action limits,
// per-rule capacity and the global quota. Returns the minimum use cost.
func (inst *instance) bruteAssign(sel []int) (int64, bool) {
	// Units to place, expanded from the demand multiset.
	var units []int // action index per unit
	for j, d := range inst.demand {
		for k := 0; k < d; k++ {
			units = append(units, j)
		}
	}
	if len(units) > inst.quota {
		return 0, false
	}
	remaining := make([]int, len(sel)) // per-rule remaining capacity
	usedAction := make([][]int, len(sel))
	for k, i := range sel {
		remaining[k] = inst.effCap(i)
		usedAction[k] = make([]int, len(inst.actions))
	}
	best := noSolution
	var rec func(u int, cost int64)
	rec = func(u int, cost int64) {
		if cost >= best {
			return
		}
		if u == len(units) {
			best = cost
			return
		}
		a := units[u]
		for k, i := range sel {
			r := &inst.rules[i]
			if remaining[k] <= 0 {
				continue
			}
			if usedAction[k][a] >= r.Actions[inst.actions[a]] {
				continue
			}
			remaining[k]--
			usedAction[k][a]++
			rec(u+1, cost+r.UseCost)
			remaining[k]++
			usedAction[k][a]--
		}
	}
	rec(0, 0)
	if best == noSolution {
		return 0, false
	}
	return best, true
}
