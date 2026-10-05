package transport

// SolveResult summarizes a branch-and-bound solve.
type SolveResult struct {
	Found     bool
	Best      []int // optimal assignment
	BestCost  [Scenarios]int
	Objective int
	Frontier  []FrontierPoint // saved Pareto frontier of feasible solutions
	Nodes     int             // search nodes expanded
	Pruned    int             // nodes pruned by bound or constraint
	Lower     int             // proven lower bound on the optimum
	Upper     int             // best (smallest) upper bound found
}

// Solve runs a depth-first branch and bound over indivisible assignments.
// It keeps the best upper bound, a running lower bound from partial costs,
// and saves the Pareto frontier of all feasible solutions it encounters.
func Solve(p *Problem) SolveResult {
	n, m := len(p.Orders), len(p.Lines)
	res := SolveResult{Objective: -1, Upper: -1}
	a := make([]int, n)
	load := make([][Scenarios]int, m)
	zoneLoad := make([]int, len(p.ZoneCap))
	var partial [Scenarios]int
	usedFixed := 0 // fixed costs already committed by used lines
	lineUsed := make([]bool, m)

	// windowOK: order o may ride line l only if the arrival time lies inside
	// the order's window in every scenario.
	windowOK := func(o, l int) bool {
		for s := 0; s < Scenarios; s++ {
			t := p.Lines[l].Travel[s]
			if t < p.Orders[o].Window.Earliest || t > p.Orders[o].Window.Latest {
				return false
			}
		}
		return true
	}
	// precedenceOK: assigning order o to line l must not violate any
	// precedence pair whose other endpoint is already assigned.
	precedenceOK := func(o, l, depth int) bool {
		for _, pr := range p.Precedence {
			switch {
			case pr[0] == o && pr[1] < depth:
				ol := a[pr[1]]
				for s := 0; s < Scenarios; s++ {
					if p.Lines[l].Travel[s] > p.Lines[ol].Travel[s] {
						return false
					}
				}
			case pr[1] == o && pr[0] < depth:
				ol := a[pr[0]]
				for s := 0; s < Scenarios; s++ {
					if p.Lines[ol].Travel[s] > p.Lines[l].Travel[s] {
						return false
					}
				}
			default:
				continue
			}
		}
		return true
	}

	var dfs func(depth int)
	dfs = func(depth int) {
		res.Nodes++
		if depth == n {
			c := partial
			for s := 0; s < Scenarios; s++ {
				c[s] += usedFixed
			}
			obj := Objective(c)
			res.Frontier = addFrontier(res.Frontier, FrontierPoint{Cost: c, Assignment: append([]int(nil), a...)})
			if res.Upper < 0 || obj < res.Upper {
				res.Upper = obj
			}
			if res.Objective < 0 || obj < res.Objective {
				res.Objective = obj
				res.BestCost = c
				res.Best = append([]int(nil), a...)
				res.Found = true
			}
			return
		}
		o := depth
		ord := &p.Orders[o]
		for l := 0; l < m; l++ {
			ln := &p.Lines[l]
			if ord.Zone != ln.Zone || !windowOK(o, l) || !precedenceOK(o, l, depth) {
				res.Pruned++
				continue
			}
			if zoneLoad[ord.Zone]+ord.Demand > p.ZoneCap[ord.Zone] {
				res.Pruned++
				continue
			}
			capOK := true
			for s := 0; s < Scenarios; s++ {
				if load[l][s]+ord.Demand > ln.Capacity[s] {
					capOK = false
				}
			}
			if !capOK {
				res.Pruned++
				continue
			}
			// Bound: partial cost plus committed fixed costs is a lower
			// bound on every completion (all costs are non-negative).
			// Prune only when a saved frontier point dominates that lower
			// bound, so every completion is dominated; this keeps the
			// saved frontier exact while still proving optimality.
			firstUse := !lineUsed[l]
			addFixed := 0
			if firstUse {
				addFixed = ln.FixedCost
			}
			var lb [Scenarios]int
			for s := 0; s < Scenarios; s++ {
				lb[s] = partial[s] + p.AssignCost[o][l][s] + usedFixed + addFixed
			}
			dominated := false
			for _, q := range res.Frontier {
				le := true
				for s := 0; s < Scenarios; s++ {
					if q.Cost[s] > lb[s] {
						le = false
					}
				}
				if le {
					dominated = true
					break
				}
			}
			if dominated {
				res.Pruned++
				continue
			}
			// Assign and recurse.
			a[o] = l
			lineUsed[l] = true
			usedFixed += addFixed
			zoneLoad[ord.Zone] += ord.Demand
			for s := 0; s < Scenarios; s++ {
				load[l][s] += ord.Demand
				partial[s] += p.AssignCost[o][l][s]
			}
			dfs(depth + 1)
			for s := 0; s < Scenarios; s++ {
				load[l][s] -= ord.Demand
				partial[s] -= p.AssignCost[o][l][s]
			}
			zoneLoad[ord.Zone] -= ord.Demand
			usedFixed -= addFixed
			lineUsed[l] = !firstUse
		}
	}
	dfs(0)
	// The search is exhaustive modulo safe pruning, so the best upper bound
	// found is also the proven lower bound on the optimum.
	res.Lower = res.Upper
	return res
}
