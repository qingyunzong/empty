package main

// BruteForce exhaustively enumerates every integer allocation
// g_i in [min_i, cycle] that satisfies all clique capacity constraints,
// keeps those admitting a feasible slot schedule, and returns the minimum
// total cost together with one witnessing allocation. It is an independent
// cross-check of Solve for tiny instances.
func BruteForce(inst *Instance) (best []int, total int, checked, feasible int, ok bool) {
	n := len(inst.Phases)
	adj := inst.adjacency()
	cliques := maximalCliques(adj)
	cliquesOf := make([][]int, n)
	for ci, c := range cliques {
		for v := 0; v < n; v++ {
			if c&(1<<v) != 0 {
				cliquesOf[v] = append(cliquesOf[v], ci)
			}
		}
	}
	residual := make([]int, len(cliques))
	for i := range residual {
		residual[i] = inst.Cycle
	}
	cur := make([]int, n)
	total = -1
	var dfs func(ph, cost int)
	dfs = func(ph, cost int) {
		if ph == n {
			checked++
			if Schedule(inst, cur) == nil {
				return
			}
			feasible++
			if total < 0 || cost < total {
				total = cost
				best = append([]int(nil), cur...)
			}
			return
		}
		for g := inst.Phases[ph].Min; g <= inst.Cycle; g++ {
			fits := true
			for _, ci := range cliquesOf[ph] {
				if residual[ci] < g {
					fits = false
					break
				}
			}
			if !fits {
				continue
			}
			for _, ci := range cliquesOf[ph] {
				residual[ci] -= g
			}
			cur[ph] = g
			dfs(ph+1, cost+inst.CostOf(ph, g))
			for _, ci := range cliquesOf[ph] {
				residual[ci] += g
			}
		}
	}
	dfs(0, 0)
	return best, total, checked, feasible, total >= 0
}
