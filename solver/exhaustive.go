package solver

// SolveExhaustive enumerates all 2^n subsets and returns the optimal
// feasible selection. It is independent of the branch-and-bound
// implementation and exists to cross-check it on small instances.
func SolveExhaustive(inst *Instance) (*Result, error) {
	c, err := compile(inst)
	if err != nil {
		return nil, err
	}
	n := c.n
	total := uint64(1) << uint(n)

	bestCost, bestCount, bestTime := -1, 0, 0
	var bestMask uint64
	nodes := 0

	for mask := uint64(0); mask < total; mask++ {
		nodes++
		// Prerequisite closure: every selected test's closure must be
		// contained in the mask.
		closed := true
		cost, count, time := 0, 0, 0
		covB := newBitset(len(inst.Branches))
		covP := newBitset(len(inst.Pairs))
		overTime := false
		for m := mask; m != 0 && closed && !overTime; m &= m - 1 {
			t := bitsTrailing(m)
			if c.closure[t]&^mask != 0 {
				closed = false
				break
			}
			cost += c.costs[t]
			time += c.times[t]
			count++
			if time > inst.TimeLimit {
				overTime = true
				break
			}
			covB.unionInto(c.coverB[t])
			covP.unionInto(c.coverP[t])
		}
		if !closed || overTime {
			continue
		}
		if !covB.contains(c.reqB) || !covP.contains(c.reqP) {
			continue
		}
		if bestCost < 0 || cost < bestCost || (cost == bestCost && count < bestCount) {
			bestCost, bestCount, bestTime, bestMask = cost, count, time, mask
		}
	}

	res := &Result{Stats: Stats{Nodes: nodes}}
	if bestCost < 0 {
		res.Status = Infeasible
		return res, nil
	}
	res.Status = Optimal
	res.Cost, res.Count, res.Time = bestCost, bestCount, bestTime
	res.Stats.BoundCost, res.Stats.BoundCount = bestCost, bestCount
	for i := 0; i < n; i++ {
		if bestMask&(1<<uint(i)) != 0 {
			res.Selected = append(res.Selected, i)
		}
	}
	return res, nil
}
